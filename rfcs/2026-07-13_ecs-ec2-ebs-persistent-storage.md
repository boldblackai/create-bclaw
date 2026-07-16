# Move claw storage from EFS to persistent EBS on ECS (EC2 launch type)

**Date:** 2026-07-13
**Status:** Implemented

> ## Revision — integration-cycle implementation (2026-07-13)
>
> The prototype built in `/alt/integration`
> deviates from the original *Technical Details* below in two load-bearing
> ways, surfaced while implementing. The body has not been rewritten; this
> block is the authoritative delta:
>
> 1. **Networking: `awsvpc` → `host` (the RFC as written would produce a dead
>    claw).** The original plan keeps `awsvpc` + a public subnet + no NAT
>    gateway. That works on Fargate (`AssignPublicIp: ENABLED` gives the task
>    ENI a public IP) but is **broken on the EC2 launch type**: per AWS docs,
>    awsvpc task ENIs on EC2 instances are never given a public IP, and awsvpc
>    tasks in public subnets have **no internet** without a NAT gateway —
>    `AssignPublicIp` is Fargate-only. The bot could not reach Slack (socket
>    mode), ghcr.io (image pull), or `ssmmessages` (ECS Exec). Fixed by dropping
>    to **`NetworkMode: host`**: the container rides the container instance's
>    primary ENI (public IP via the launch template), restoring outbound with
>    no NAT. SG-per-task isolation (the RFC's only stated reason to keep
>    awsvpc) is a distinction without a difference at 1 task : 1 instance, so
>    nothing is lost; the single inbound-less SG moves to the instance ENI, and
>    the ECS `Service` drops its `NetworkConfiguration` entirely. ECS Exec still
>    works over the host's internet path. *Pending live verification of ECS
>    Exec on host networking.*
> 2. **Self-healing: standalone instance → ASG `min=max=desired=1`.** The
>    original plan uses a standalone `AWS::EC2::Instance` + a CloudWatch
>    `StatusCheckFailed_System → RecoverInstance` alarm. The implementation
>    uses an **Auto Scaling Group** instead, which also covers AWS-initiated
>    instance retirement (the alarm did not). Consequences: no CloudWatch
>    recovery alarm (the ASG + EC2 health checks are the recovery); **no
>    `AWS::EC2::VolumeAttachment`** (CFN cannot pre-attach to an ASG-managed
>    instance) — the retained standalone volume is found + attached **by tag**
>    in the UserData on every boot, with a retry loop for the `VolumeInUse` race
>    during ASG replacement; and the instance profile needs `ec2:AttachVolume`
>    scoped by a **shared `ClawName` tag** (instance and volume have different
>    `Name` values, so a per-resource `Name` condition can't match both sides
>    of an `AttachVolume` request).
>
> **Open questions resolved:** (1) **fresh volume** (no EFS→EBS data
> migration — the suspect WAL-corrupted DBs are the thing being escaped);
> (2) **ASG from the start** (above); (3) **`1024` CPU on `t4g.large`**.

## Goal

Give the Hermes Agent claw's SQLite databases (`state.db`, `kanban.db`) a real
local block device instead of a network filesystem. Replace the current
**ECS Fargate + EFS (NFS)** storage layer with **ECS on a single EC2 container
instance + persistent EBS volume** (host bind-mounts), keeping the rest of the
architecture (VPC, SSM secrets, ECS service/task, ECS Exec shell-in, signed
upstream image as-is) intact.

## Motivation

### SQLite WAL is unsafe on NFS, and EFS is NFS

SQLite's WAL journal mode requires a shared-memory segment (`-shm`) and
`fcntl`/`mmap` semantics that network filesystems do not provide correctly.
SQLite upstream is explicit: *"SQLite databases in WAL mode do not work over a
network filesystem."* EFS exposes itself to NFSv4 clients, so it falls under
that prohibition.

The upstream Hermes image hardcodes `PRAGMA journal_mode=WAL` in
`hermes_state.py` (`SessionDB`) and `hermes_cli/kanban_db.py` (`connect()`).
Upstream issue [#22032][22032] added a WAL→DELETE fallback when the WAL pragma
raises `OperationalError("locking protocol")` — that fix shipped before the
`hermes-1.9.1` (`v2026.6.19`) image we run, so **we already have the fallback.**

The problem: the fallback only fires on a **hard** error. On EFSv4 (unlike the
NFSv3 + `local_lock=none` case in the #22032 report) the WAL pragma frequently
**does not raise** — WAL *appears* to engage while the shared-memory/locking
semantics are subtly wrong, so `state.db`/`kanban.db` silently misbehave
(corruption, lost writes, the kanban dispatcher retry storm) instead of tripping
the fallback. This was confirmed by a prior investigation against the live claw
in `/alt/integration` (see session notes under `~/.pi/agent/sessions/`):
**the WAL-on-EFS corruption is real and silent in our environment.**

[22032]: https://github.com/NousResearch/hermes-agent/issues/22032

### Why not "just disable WAL" (stay on EFS + `journal_mode=DELETE`)?

Considered and rejected as the primary path (see *Alternatives*). It would need
either an upstream knob we can't reach from the signed-as-is image, or a forked
image — and even then DELETE-on-NFS is merely "more robust," not SQLite-blessed.
Re-platforming onto block storage removes the NFS caveat entirely and is the
durable fix.

### Why not EBS on Fargate?

ECS+Fargate EBS support (Jan 2024) has hard constraints that make it a poor fit
for a **single-replica, stateful** service:

- **One EBS volume per task, and it must be a new volume** — you cannot reattach
  an existing volume; only seed a new one from a snapshot.
- **Service-managed EBS volumes are deleted when the task stops.** Because the
  claw is a single-replica `AWS::ECS::Service`, every task stop (deploy, Fargate
  maintenance, health-check replacement) would wipe the DB — *worse* than EFS —
  unless we bolt on a snapshot-on-stop/restore-on-start lifecycle
  (EventBridge → Lambda → snapshot → SSM-tracked snapshot ID). That is real new
  infra to paper over a platform mismatch.

This is the load-bearing realization: **serverless container platforms (Fargate,
App Runner, Lightsail Containers) are built for stateless horizontal scale. The
claw is single-replica + stateful + SQLite-needs-block-storage.** That mismatch
is the root cause of the storage pain. The AWS-native fit for a single stateful
replica is an EC2 instance that owns a persistent EBS volume.

## Decision

**ECS on EC2 (single container instance) + a persistent EBS data volume.** We
keep ECS — and with it the task-definition shape, ECS Exec shell-in, the
setup/manage/teardown skill structure, and the signed-image-as-is model — and
swap only the launch type (Fargate→EC2) and the storage backing
(EFS→host bind-mount on EBS).

### Alternatives considered

| Option | Verdict |
| --- | --- |
| **Plain EC2 + docker/systemd** (leave ECS entirely) | Rejected for v1 — strictly less to manage than ECS-on-EC2 for the same storage outcome, but rewrites the shell-in path (SSM-on-host → `docker exec`) and the whole skill shape, not just the storage edges. Revisit if ECS ever stops pulling its weight. |
| **EBS on Fargate + snapshot lifecycle** | Rejected — adds Lambda/EventBridge/SSM machinery to paper over the per-stop volume wipe; still Fargate. |
| **Stay on EFS + force `journal_mode=DELETE`** | Rejected as primary — needs a knob the signed image doesn't expose (or a fork), and DELETE-on-NFS isn't SQLite-blessed. |
| **EKS** | Ruled out — overkill for one pod. |
| **App Runner / Lambda / Lightsail Containers** | Wrong shape — no persistent block storage (App Runner, Lightsail Containers) or not a long-running persistent connection (Lambda, 15-min cap on a socket-mode bot). |

## Technical Details

### Topology

```text
VPC (10.0.0.0/16) — kept
  └─ PublicSubnetA (AZ1) — single AZ from here on (EBS is zonal)
       └─ EC2 container instance  (t4g.large, AL2023 ECS-optimized arm64 AMI)
            ├─ instance profile: container-instance role + SSM core
            ├─ persistent EBS data volume (gp3, Retain) attached → mounted /data
            │     ├─ /data/hermes
            │     ├─ /data/xdg-config
            │     ├─ /data/mise-data
            │     └─ /data/mise-state            (uid/gid 1000 = harness user)
            └─ ECS agent registers to Cluster (via UserData)

ECS Cluster (kept)
  └─ Service (LaunchType: EC2, DesiredCount=1, EnableExecuteCommand: true)
       └─ TaskDefinition (RequiresCompatibilities: [EC2], NetworkMode: awsvpc)
            └─ container `hermes` — host bind-mounts:
                 /data/hermes      → /home/harness/.hermes
                 /data/xdg-config  → /home/harness/.config
                 /data/mise-data   → /home/harness/.local/share/mise
                 /data/mise-state  → /home/harness/.local/state/mise
```

The task keeps **awsvpc** networking (same SG-per-task isolation as today) and
**ECS Exec** is unchanged — both work on the EC2 launch type. The 4 persisted
paths survive as 4 bind-mounts; only the backing store changes from EFS access
points to EBS subdirectories.

### Persistent EBS data volume

The volume is a **standalone, retained** resource — the data follows the
container, not the instance:

- `AWS::EC2::Volume` — gp3, encrypted, `DeletionPolicy: Retain` /
  `UpdateReplacePolicy: Retain` (mirrors today's EFS retain policy — teardown
  deletes it explicitly after confirmation). `AvailabilityZone: !Ref AZ1`.
- `AWS::EC2::VolumeAttachment` — attaches the volume to the EC2 instance.
  Native CloudFormation: on instance replacement CFN detaches from the old
  instance and reattaches the **same retained volume** to the new one, so data
  survives CFN-driven instance churn without any attach-IAM gymnastics.
- `UserData` (MIME multi-part, runs on the ECS-optimized AMI): format the volume
  **if it has no filesystem** (`blkid` → `mkfs.ext4 -L bclawdata`), mount it
  **by filesystem label** (device names are not stable across instance types /
  NVMe), create the four subdirs with `chown 1000:1000`, then write
  `ECS_CLUSTER=<cluster>` into `/etc/ecs/ecs.config` so the ECS agent registers.
  Mount-by-label makes the UserData robust to the `nvme1n1` vs `/dev/xvdf`
  naming drift.

### Self-healing

A standalone `AWS::EC2::Instance` + a CloudWatch alarm on
`StatusCheckFailed_System` → `AWS::EC2::Instance.Recover` action. EC2 instance
recovery restarts the instance on healthy hardware **with the same EBS volumes
attached** — exactly the single-instance persistent-volume case, and the
simplest self-heal available. ECS reschedules the task once the agent
re-registers.

> **Not covered by v1:** full instance *termination* / retirement (status-check
> recovery handles hardware failure, not AWS-initiated retirement). Recoverable
> via a manual reattach, or by a future hardening to an **Auto Scaling Group**
> with `min=max=desired=1` + UserData that reattaches the tagged volume on each
> new instance (handles retirement auto-recovery, at the cost of an
> `ec2:AttachVolume` permission on the instance profile + AZ-pinning). Flagged
> as a follow-up, not v1, to keep the delta minimal.

### Single-AZ consequence

EBS is zonal, so the volume + instance + task all live in **AZ1**. This drops
the current 2-AZ ARM64-placement failover (the reason the template has two
subnets today). Rationale: ARM64 (Graviton) capacity in `us-east-1` is ample,
the 2-AZ hedge was a placement fallback, and correct storage is worth the loss
of that fallback. `AZ2` / `PublicSubnetB` are dropped; the setup skill probes
**one** ARM64-capable AZ and passes it as `AZ1`.

### Capacity sizing

Current Fargate task = 2048 CPU / 4096 MiB. On EC2 the task's CPU/memory must
fit in the instance's registered capacity (minus the ECS agent/OS reservation):

- Default instance **`t4g.large`** (2 vCPU / 8 GiB, Graviton) — comfortably hosts
  a **`1024`/`4096`** task with headroom for the host. (The 2048-CPU Fargate
  default is lowered to 1024 — the claw is inference-via-API, CPU-light, and
  reserving a full vCPU for the host avoids agent starvation.)
- Instance type becomes a stack **parameter** (default `t4g.large`); the template
  documents that task CPU+memory must fit the chosen instance's registered
  capacity. (`t4g.medium`/4 GiB is too small to host a 4096-MiB task after the
  agent reservation.)
- Cost ≈ **~$27/mo** (t4g.large on-demand ~$24.5 + ~30 GiB gp3 ~$2.4) vs ~$35/mo
  for Fargate — cheaper and correct.

### AMI

ECS-optimized **Amazon Linux 2023 (arm64)** via the public SSM parameter, so the
stack always launches the latest patched AMI without a hardcoded ID:

```yaml
EcsAmiId:
  Type: AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>
  Default: /aws/service/ecs/optimized-ami/amazon-linux-2023/arm64/recommended/image_id
```

The AL2023 ECS-optimized AMI ships Docker, the ECS agent, and the SSM agent
(needed for ECS Exec and host Session Manager).

### Task definition changes

- `RequiresCompatibilities: [FARGATE]` → **`[EC2]`**.
- Service: drop `LaunchType: FARGATE`, set **`LaunchType: EC2`**; drop
  `AssignPublicIp` (Fargate-only — the instance gets its public IP via the
  launch template). `NetworkConfiguration.AwsvpcConfiguration.Subnets` collapses
  to the single AZ1 subnet.
- **Volumes**: replace the four `EFSVolumeConfiguration` entries with **host
  bind-mount volumes** (`sourcePath` is EC2-only, which is why this needs the EC2
  launch type):

  ```yaml
  Volumes:
    - { Name: hermes-data,      Host: { SourcePath: /data/hermes } }
    - { Name: hermes-config,    Host: { SourcePath: /data/xdg-config } }
    - { Name: hermes-mise-data, Host: { SourcePath: /data/mise-data } }
    - { Name: hermes-mise-state,Host: { SourcePath: /data/mise-state } }
  ```

  The `MountPoints` stay byte-for-byte the same.
- Drop `TaskDefinition.DependsOn: [EFSMountTargetA, EFSMountTargetB]`; add
  `DependsOn: VolumeAttachment` so the task never schedules before `/data` is
  mounted.
- `RuntimePlatform` / `CpuArchitecture`, the `hermes` container `Command`
  (gh-auth + `exec hermes gateway`), `Environment`, `Secrets`, ECS Exec task
  role, execution role, KMS — all **unchanged**.

### IAM

- **TaskRole** (ECS Exec ssmmessages) — unchanged.
- **ExecutionRole** (SSM GetParameters + KMS + ECR pull) — unchanged.
- **NEW — InstanceProfile + container-instance role**:
  - managed `AmazonEC2ContainerServiceforEC2Role` (lets the instance register &
    talk to ECS), and
  - managed `AmazonSSMManagedInstanceCore` (SSM agent for ECS Exec + host
    Session Manager).
  - (With a standalone instance + native `VolumeAttachment`, the UserData does
    **not** call any EC2 API, so the instance profile needs no `ec2:*` perms —
    only the two managed policies above.)
- **`bclaw-deploy-policy.json`** — edit: drop the `elasticfilesystem:*` block;
  add `ec2:CreateVolume/AttachVolume/DeleteVolume/DetachVolume`,
  `ec2:RunInstances/CreateTags` (for the instance), `ec2:CreateLaunchTemplate*`
  (if we adopt a launch template), and `cloudwatch:PutMetricAlarm` (recovery
  alarm). Scope EC2 perms to the claw's tag (`aws:ResourceTag/Name: <name>-*`)
  like the existing EFS scoping.

### Security group

Drop `SecurityGroupSelfIngress` (NFS 2049) — there is no EFS to reach. The SG is
now outbound-only (still used by the awsvpc task ENI and the instance's primary
ENI for SSM + ECS agent + Slack socket mode). The claw remains inbound-less.

### What gets removed from `template.yaml`

`EFSFileSystem`, the four `AWS::EFS::AccessPoint` resources, `EFSMountTargetA`,
`EFSMountTargetB`, `SecurityGroupSelfIngress`, the `AZ2` parameter, and
`PublicSubnetB` + its route-table association. `TaskDefinition`'s EFS volumes.
The `EFSFileSystemId` output is replaced by an `EbsVolumeId` output.

### What gets added

`AWS::EC2::Instance` (or `LaunchTemplate` if we later move to an ASG),
`AWS::EC2::Volume` (retained), `AWS::EC2::VolumeAttachment`, the
`InstanceProfile` + container-instance `Role`, the `EcsAmiId` SSM parameter, the
recovery CloudWatch `Alarm`, and an `InstanceType` parameter.

## Skill changes (setup / manage / teardown)

The skill **shape is preserved** (this is why ECS-on-EC2 won over plain EC2).
The edits are scoped to the storage/launch-type specifics:

- **setup-bclaw** — `template.yaml` rewrite per above; the AZ-probing step
  returns **one** ARM64 AZ (not two); the description/phase prose that says
  "EFS-backed" / "4 access points" becomes "EBS-backed" / "host bind-mounts on a
  persistent gp3 volume". The first-deploy `DesiredCount=0` cadence is unchanged.
- **manage-bclaw** — any EFS-specific mount/health checks become EBS checks
  (`describe-volumes`, the mount point at `/data`).
- **teardown-bclaw** — Phase 3 swaps "delete the retained EFS file system" for
  "delete the retained EBS volume" (`aws ec2 delete-volume`); the EFS
  mount-target cleanup steps and the `describe-mount-targets`/`delete-file-system`
  calls go away (replaced by detach + delete-volume). The orphaned-VPC sweep
  (Phase 4) simplifies — no EFS mount-target ENIs to block subnet deletion.
  Tag-conditioned delete permission moves from EFS to EC2 (`ec2:DeleteVolume`
  scoped by tag).

All shipped skill content stays **factual and present-tense** per the repo's
skill rules — no migration narrative, no "previously EFS…" framing inside
`template/`.

## Migration Notes

- **Existing `/alt/integration` claw has live data on EFS.** This RFC's
  integration cycle stands up the new EC2+EBS stack fresh; moving the existing
  EFS state onto the new EBS volume is an open question (see *Open questions*).
  The default assumption for the cycle is a **fresh volume** (the claw's
  sessions/memories are regenerable; the SQLite DBs are the part we're *fixing*,
  so carrying forward a suspect DB is undesirable).
- **Golden test** (`test/golden.test.mjs`) is unaffected in *mechanism* — it
  still asserts `create-bclaw bclaw` reproduces `template/` byte-for-byte and the
  rename is complete — but the template it compares against changes. The
  `bclaw`-only rename invariant still holds (no new immutable tokens are
  introduced by the storage change).
- **Integration cycle required.** Per the repo workflow, prototype + deploy +
  verify in `/alt/integration` (confirm WAL is healthy on the EBS-backed
  `state.db`/`kanban.db`, ECS Exec works, recovery behavior), **then** port back
  into `template/` and reconcile with `diff -rq /workspace/template
  /alt/integration …`.

## Implementation notes

Implemented in `/workspace/template/` and verified end-to-end in
`/alt/integration` (live deploy + WAL/ECS-Exec/recovery checks all green).
`pnpm test`
(golden), `pnpm lint`, and `pnpm exec tsc --noEmit` all pass after the port-back.

### What shipped (the deviations from the original *Technical Details* are

authoritative — see the Revision block at the top)

- **`template.yaml`**: EFS/Fargate/awsvpc/2-AZ resources removed; replaced with
  standalone retained `AWS::EC2::Volume` + `AWS::EC2::LaunchTemplate` +
  `AWS::AutoScaling::AutoScalingGroup` (`min=max=desired=1`, EC2 launch type) +
  container-instance role + instance profile + ECS-optimized AL2023 arm64 AMI
  via the public SSM parameter. Task uses `NetworkMode: host`; service has
  `DeploymentConfiguration: MinimumHealthyPercent: 0` (recreate) + circuit
  breaker. No `VolumeAttachment`, no CloudWatch recovery alarm (the ASG + EC2
  health checks are the recovery).
- **UserData**: the volume ID is **baked in via `Fn::Sub`**
  (`VOL_ID='${EbsDataVolume}'`) — no runtime `describe-volumes`/tag lookup, so
  leftover retained orphan volumes can't shadow the stack's current volume. The
  UserData finds the attached block device via `ebsnvme-id` (polling up to 60s
  for NVMe enumeration), formats-if-fresh (`mkfs.ext4 -L clawdata`), mounts by
  label, mkdirs the 4 subdirs `chown 1000:1000`, and writes `ECS_CLUSTER`.
  **It does NOT `systemctl restart ecs`** — ecs.service is `After=cloud-final`,
  and UserData runs inside cloud-final, so a restart deadlocks; writing
  `ECS_CLUSTER` and exiting lets systemd start ecs.service itself (~30s to
  registration).
- **Deploy policy**: dropped EFS + `SimulateSelf`; added EC2 volume / launch-
  template / autoscaling / instance-profile / ASG-SLR perms, the public-AMI SSM
  read, `ec2:RunInstances` (unscoped, in `EC2LaunchTemplateManage`),
  `DescribeImages`, `cloudformation:DescribeStackResources`, and
  `sts:DecodeAuthorizationMessage`. `TerminateInstances` was **not** added — it
  and `ec2:GetConsoleOutput` (both absent from the policy) are introduced
  tag-scoped in the 2026-07-14 tag-scoped-instance-permissions RFC. Likewise no
  SSM host-debug perms ship: `ssm:StartSession` is explicitly denied and
  `ssm:SendCommand` is absent. Compacted under the 6144-char managed-policy
  limit by merging statements (consolidated `ReadOnlyDescribe`, `PassRole` with
  a two-entry Resource and NO `PassedToService` condition — the condition broke
  the ASG launch-template validation).
- **Skills**: setup/manage/teardown rewritten for the new model; setup folded in
  a Phase 5 Overlay; teardown added a Phase 4 orphan-VPC sweep. `template/README.md`
  - `template/AGENTS.md` updated for the new storage/launch model.

### Verified live in `/alt/integration`

1. Task `RUNNING` + steady state on the EC2 instance (1024 CPU / 4096 MiB,
   single AZ).
2. ECS Exec shell-in works over host networking (no awsvpc/NAT/VPC endpoints).
3. **WAL healthy on EBS** — `PRAGMA journal_mode=wal`, `integrity_check=ok` on
   both `state.db` and `kanban.db`, with `-shm` present (the migration's core
   goal — SQLite WAL now runs on a real block device, not NFS).
4. **ASG recovery + EBS reattach** — a marker file survived instance
   replacement; the same retained volume reattached by baked ID.
5. **Recreate deploy** — `force-new-deployment` completes (stop-old-then-
   start-new) instead of stalling; secret rotations / image upgrades work.

### Follow-ups (not blocking)

- The `/alt/integration` `agent_home/SOUL.md` persona content drifted from the
  canonical during the cycle (co-author guidance wording). **Not** architecture;
  left as the canonical shipped default — a separate curatorial decision.
- Standalone-instance hardening (the original *Technical Details* model) is
  superseded by the ASG; if the ASG ever stops pulling its weight, the original
  standalone + `RecoverInstance`-alarm design in the *Decision* section is the
  fallback.

## Open questions

*All resolved at integration-cycle kickoff (2026-07-13); see the Revision
block at the top for the full rationale.*

1. **Migrate existing EFS data onto the new EBS volume, or start fresh?** →
   **Fresh.** The suspect WAL-corrupted `state.db`/`kanban.db` are the thing
   being escaped; sessions/memories are regenerable. The EBS volume starts
   empty.
2. **Standalone instance now vs. ASG from the start?** → **ASG
   `min=max=desired=1`.** Covers AWS-initiated instance retirement
   (a standalone instance + `RecoverInstance` alarm does not). See Revision §2.
3. **Task CPU on the new host** → **`1024` CPU on `t4g.large`** (reserves a full
   vCPU for the host; the claw is inference-via-API, CPU-light).
