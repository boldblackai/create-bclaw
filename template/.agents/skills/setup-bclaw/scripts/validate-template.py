#!/usr/bin/env python3
"""
Validate CloudFormation template.yaml — CFN-tag-aware.

PROBLEM THIS SOLVES:
  The patch/write_file tools lint edited files with PyYAML, which does not
  understand CloudFormation intrinsic-function shorthand (!Ref, !Sub, !If,
  !Equals, !GetAtt, etc.). Every edit to template.yaml produces a lint
  "error" like:  could not determine a constructor for the tag '!Equals'
  These are FALSE POSITIVES — the shorthand is valid CloudFormation. This
  script parses the template with a multi-constructor that handles all `!`
  tags, so it catches REAL structural problems (malformed YAML, broken
  indentation, missing keys) without the noise.

USAGE:
  python3 scripts/validate-template.py [path/to/template.yaml]

  If no path is given, defaults to template.yaml in the skill directory.

WHAT IT CHECKS:
  - Template parses as valid YAML (with CFN tags resolved)
  - Required top-level keys present (Parameters, Conditions, Resources, Outputs)
  - Every Condition referenced by a !If exists in Conditions
  - Every Parameter referenced by a !Ref in Conditions exists in Parameters
  - Lists the Parameters, Conditions, and task-definition Secrets entries
"""
import sys
import os

try:
    import yaml
except ImportError:
    print("ERROR: PyYAML not installed.", file=sys.stderr)
    sys.exit(2)


class CfnLoader(yaml.SafeLoader):
    """SafeLoader that resolves CloudFormation shorthand intrinsic tags."""


def _resolve_tag(loader, tag_suffix, node):
    """Resolve any !Tag into {Tag: <value>} so structure is inspectable."""
    tag_name = tag_suffix.lstrip("!")
    if isinstance(node, yaml.ScalarNode):
        return {tag_name: loader.construct_scalar(node)}
    if isinstance(node, yaml.SequenceNode):
        return {tag_name: loader.construct_sequence(node, deep=True)}
    return {tag_name: loader.construct_mapping(node, deep=True)}


CfnLoader.add_multi_constructor("!", _resolve_tag)


def find_template():
    """Find template.yaml relative to this script's location."""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(script_dir, "..", "template.yaml")


def collect_if_refs(obj, refs=None):
    """Walk a parsed structure and collect all condition names used in !If."""
    if refs is None:
        refs = []
    if isinstance(obj, dict):
        for key, val in obj.items():
            if key == "If" and isinstance(val, list) and val:
                cond = val[0]
                if isinstance(cond, str):
                    refs.append(cond)
            else:
                collect_if_refs(val, refs)
    elif isinstance(obj, list):
        for item in obj:
            collect_if_refs(item, refs)
    return refs


def collect_ref_params(obj, params=None):
    """Walk Conditions block and collect !Ref'd parameter names."""
    if params is None:
        params = []
    if isinstance(obj, dict):
        for key, val in obj.items():
            if key == "Ref" and isinstance(val, str) and not val.startswith("AWS::"):
                params.append(val)
            else:
                collect_ref_params(val, params)
    elif isinstance(obj, list):
        for item in obj:
            collect_ref_params(item, params)
    return params


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else find_template()
    path = os.path.normpath(path)

    if not os.path.isfile(path):
        print(f"ERROR: template not found: {path}", file=sys.stderr)
        sys.exit(2)

    with open(path) as f:
        try:
            doc = yaml.load(f, Loader=CfnLoader)
        except yaml.YAMLError as e:
            print(f"FAIL: template has a real YAML error:\n  {e}", file=sys.stderr)
            sys.exit(1)

    errors = []

    # Top-level structure
    for key in ("Parameters", "Conditions", "Resources", "Outputs"):
        if key not in doc:
            errors.append(f"missing top-level key: {key}")

    params = doc.get("Parameters", {})
    conditions = doc.get("Conditions", {})
    resources = doc.get("Resources", {})

    print("=== Parameters ===")
    for name in sorted(params.keys()):
        p = params[name]
        default = p.get("Default", "(none)")
        print(f"  {name}: default={default}")

    print("\n=== Conditions ===")
    for name in sorted(conditions.keys()):
        print(f"  {name}")

    # Validate !If condition references exist
    if_refs = set(collect_if_refs(resources))
    missing_conds = if_refs - set(conditions.keys())
    if missing_conds:
        errors.append(f"!If references unknown conditions: {sorted(missing_conds)}")

    # Validate !Ref in Conditions point to real Parameters
    ref_params = set(collect_ref_params(conditions))
    missing_params = ref_params - set(params.keys())
    if missing_params:
        errors.append(f"Conditions !Ref unknown parameters: {sorted(missing_params)}")

    # Guard: ECS service DesiredCount must be a !Ref, not a hardcoded literal.
    # A hardcoded DesiredCount: 0 is re-applied on every stack update and silently
    # takes the claw down. It must be a parameter (default 1) so an update that
    # omits it keeps the service running.
    svc_resources = [r for r in resources.values()
                     if isinstance(r, dict) and r.get("Type") == "AWS::ECS::Service"]
    if svc_resources:
        dc = svc_resources[0].get("Properties", {}).get("DesiredCount")
        if not (isinstance(dc, dict) and "Ref" in dc and dc["Ref"] == "DesiredCount"):
            errors.append(
                "AWS::ECS::Service DesiredCount must be !Ref DesiredCount, not a "
                f"hardcoded literal (got {dc!r}); make it a parameter defaulting to 1"
            )

    # Inspect task definition secrets
    td_resources = [r for r in resources.values() if isinstance(r, dict) and r.get("Type") == "AWS::ECS::TaskDefinition"]
    if td_resources:
        td = td_resources[0]
        containers = td.get("Properties", {}).get("ContainerDefinitions", [])
        if containers:
            secrets = containers[0].get("Secrets", [])
            print("\n=== Task Definition Secrets ===")
            for s in secrets:
                if isinstance(s, dict) and "Name" in s:
                    print(f"  {s['Name']} (required)")
                elif isinstance(s, dict) and "If" in s:
                    cond_name = s["If"][0]
                    inner = s["If"][1]
                    name = inner.get("Name", "?") if isinstance(inner, dict) else "?"
                    print(f"  {name} (conditional on {cond_name})")
                else:
                    print(f"  {s} (unrecognized format)")
                    errors.append(f"unrecognized secret entry format: {s}")

    print()
    if errors:
        print("FAIL:")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)
    else:
        print("OK: template structure is valid.")
        sys.exit(0)


if __name__ == "__main__":
    main()
