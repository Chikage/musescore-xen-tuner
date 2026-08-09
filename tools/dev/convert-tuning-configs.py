"""
Batch converter between Xen Tuner legacy .txt tuning configs and compact JSON.

Run from the project root, for example:

    python tools/dev/convert-tuning-configs.py txt-to-json tunings/26edo.txt --out-dir tmp
    python tools/dev/convert-tuning-configs.py json-to-txt tunings/26edo.json --out-dir tmp
    python tools/dev/convert-tuning-configs.py auto tunings --recursive --out-dir tmp
"""

import argparse
import json
import re
import sys
from pathlib import Path


DECLARATION_RE = re.compile(
    r"^(lig|aux|sec|explicit|nobold|override|displaycents|displaysteps)\("
)
CHAIN_CENTER_RE = re.compile(r"^\((.*)\)$")
NUMERIC_RE = re.compile(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$")


class ConversionError(Exception):
    pass


def strip_comment(line):
    return line.split("//", 1)[0].rstrip()


def clean_tuning_lines(text):
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = []
    for raw_line in text.split("\n"):
        line = strip_comment(raw_line).strip()
        if line:
            lines.append(line)
    return lines


def parse_number_literal(text):
    if not NUMERIC_RE.match(text):
        return text
    if re.search(r"[.eE]", text):
        return float(text)
    return int(text)


def looks_like_interval(text):
    return any(char.isdigit() for char in text)


def value_to_text(value):
    if value is None:
        raise ConversionError("JSON value cannot be null in compact tuning text fields")
    if isinstance(value, bool):
        return "1" if value else "0"
    return str(value)


def interval_to_text(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value == 0:
        return "0c"
    return value_to_text(value)


def parse_reference(line):
    parts = [part.strip() for part in line.split(":", 1)]
    if len(parts) != 2 or not parts[0] or not parts[1]:
        raise ConversionError("first non-comment line must be a reference tuning like C4: 261.625")
    return {parts[0]: parse_number_literal(parts[1])}


def parse_chain_line(line):
    words = line.split()
    if not words:
        raise ConversionError("empty accidental chain")

    center_index = None
    step = None
    chain = []
    for idx, word in enumerate(words):
        match = CHAIN_CENTER_RE.match(word)
        if match and looks_like_interval(match.group(1)):
            if center_index is not None:
                raise ConversionError("accidental chain has more than one origin/increment marker")
            center_index = idx
            step = match.group(1)
            chain.append(0)
        else:
            chain.append(word)

    if center_index is None:
        raise ConversionError("accidental chain is missing an origin/increment marker like (1\\26)")

    return {"step": step, "chain": chain}


def parse_aux_declaration(line):
    match = re.match(r"^aux\(([0-9,\s]+)\)$", line)
    if not match:
        raise ConversionError("invalid aux declaration: " + line)
    return [int(part.strip()) for part in match.group(1).split(",") if part.strip()]


def parse_display_steps(line):
    match = re.match(r"^displaysteps\(([0-9,\sa-zA-Z]+)\)$", line)
    if not match:
        return None
    parts = [part.strip() for part in match.group(1).split(",")]
    if len(parts) != 2:
        raise ConversionError("displaysteps expects two arguments: " + line)
    return {"steps": int(parts[0]), "position": parts[1]}


def parse_display_cents(line):
    match = re.match(r"^displaycents\(([0-9,\sa-zA-Z]+)\)$", line)
    if not match:
        return None
    parts = [part.strip() for part in match.group(1).split(",")]
    if len(parts) != 3:
        raise ConversionError("displaycents expects three arguments: " + line)
    return {"reference": parts[0], "precision": int(parts[1]), "position": parts[2]}


def unescape_text_accidental(word):
    if not word.startswith("'"):
        return None

    text = []
    escaped = False
    for idx in range(1, len(word)):
        char = word[idx]
        if escaped:
            text.append(char)
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if char == "'":
            if idx != len(word) - 1:
                raise ConversionError("quoted text accidental has trailing text: " + word)
            return "".join(text)
        text.append(char)

    raise ConversionError("quoted text accidental is missing a closing quote: " + word)


def escape_text_accidental(text):
    return "'" + str(text).replace("\\", "\\\\").replace("'", "\\'").replace("/", "\\/") + "'"


def parse_secondary_line(line):
    words = line.split()
    if len(words) < 2:
        raise ConversionError("secondary accidental declaration is too short: " + line)

    text = unescape_text_accidental(words[0])
    if text is not None:
        if len(words) == 2:
            return {"text": text, "symbol": escape_text_accidental(text), "step": words[1]}
        step = words[2:] if len(words) > 3 else words[2]
        return {"text": text, "symbol": parse_number_literal(words[1]), "step": step}

    step = words[1:] if len(words) > 2 else words[1]
    return {"symbol": parse_number_literal(words[0]), "step": step}


def compact_json_from_txt(text, name=None):
    lines = clean_tuning_lines(text)
    if len(lines) < 2:
        raise ConversionError("tuning config needs at least reference and nominal lines")

    ref = parse_reference(lines[0])
    nom = lines[1].split()
    chains = []
    idx = 2
    while idx < len(lines) and not DECLARATION_RE.match(lines[idx]):
        chains.append(parse_chain_line(lines[idx]))
        idx += 1

    aux_order = []
    sec = []
    extra = []
    opt = {"explicit": 0, "nobold": 0}
    in_sec = False

    while idx < len(lines):
        line = lines[idx]

        if line == "sec()":
            in_sec = True
            idx += 1
            continue

        if DECLARATION_RE.match(line):
            in_sec = False

            if line.startswith("aux("):
                aux_order.append(parse_aux_declaration(line))
            elif line == "explicit()":
                opt["explicit"] = 1
            elif line == "nobold()":
                opt["nobold"] = 1
            elif line.startswith("displaysteps("):
                opt["displaysteps"] = parse_display_steps(line)
            elif line.startswith("displaycents("):
                opt["displaycents"] = parse_display_cents(line)
            else:
                extra.append(line)
        elif in_sec:
            sec.append(parse_secondary_line(line))
        else:
            extra.append(line)

        idx += 1

    aux = {}
    if any(0 in entry for entry in aux_order):
        aux["0"] = "nom"
    for chain_idx, chain in enumerate(chains, start=1):
        aux[str(chain_idx)] = chain
    if aux_order:
        aux["order"] = aux_order
    aux["auxExtra"] = [
        entry for entry in aux_order
        if not (len(entry) == 1 and entry[0] in range(0, len(chains) + 1))
    ]

    config = {}
    if name:
        config["tun"] = name
    config["ref"] = ref
    config["nom"] = nom
    config["aux"] = aux
    if sec:
        config["sec"] = sec
    if opt.get("explicit") or opt.get("nobold") or opt.get("displaysteps") or opt.get("displaycents"):
        config["opt"] = opt
    else:
        config["opt"] = {"explicit": 0, "nobold": 0}
    if extra:
        config["extra"] = extra
    return config


def symbol_count(value):
    text = value_to_text(value)
    if not text:
        return 0
    return len(text.split("."))


def sort_secondary_entries(sec):
    return sorted(
        sec,
        key=lambda entry: (
            -symbol_count(entry.get("symbol", "")),
            -len(value_to_text(entry.get("text", ""))),
        ),
    )


def reference_to_line(ref):
    if isinstance(ref, str):
        return ref
    if not isinstance(ref, dict) or len(ref) != 1:
        raise ConversionError("JSON ref must be a string or an object with exactly one note")
    note = next(iter(ref))
    return note + ": " + value_to_text(ref[note])


def format_aux_declaration(entry):
    if isinstance(entry, str):
        return entry if entry.startswith("aux(") else "aux(" + entry + ")"
    if isinstance(entry, int):
        return "aux(" + str(entry) + ")"
    if isinstance(entry, list):
        return "aux(" + ",".join(str(int(part)) for part in entry) + ")"
    raise ConversionError("invalid aux order entry: " + repr(entry))


def format_step_list(step):
    if isinstance(step, list):
        return " ".join(interval_to_text(item) for item in step)
    return interval_to_text(step)


def compact_json_to_txt(config):
    if not isinstance(config, dict):
        raise ConversionError("compact JSON root must be an object")

    lines = [
        reference_to_line(config.get("ref") if "ref" in config else config.get("reference")),
        " ".join(interval_to_text(item) for item in config.get("nom", [])),
    ]

    aux = config.get("aux") or {}
    if not isinstance(aux, dict):
        raise ConversionError("JSON aux must be an object")

    numeric_keys = sorted(
        [key for key in aux if str(key).isdigit()],
        key=lambda key: int(key),
    )
    for key in numeric_keys:
        entry = aux[key]
        if isinstance(entry, dict) and isinstance(entry.get("chain"), list):
            step = interval_to_text(first_defined(entry, ("step", "increment")))
            chain_words = []
            for item in entry["chain"]:
                if isinstance(item, (int, float)) and not isinstance(item, bool) and item == 0:
                    chain_words.append("(" + step + ")")
                else:
                    chain_words.append(value_to_text(item))
            lines.append(" ".join(chain_words))
        elif int(key) != 0:
            raise ConversionError("JSON aux entry " + str(key) + " must contain a chain")

    if config.get("extra"):
        lines.extend(value_to_text(line) for line in config["extra"])

    aux_order = aux.get("order") or aux.get("auxOrder")
    if aux_order:
        for entry in aux_order:
            lines.append(format_aux_declaration(entry))
    else:
        for key in numeric_keys:
            lines.append("aux(" + str(int(key)) + ")")

    for entry in aux.get("auxExtra", []):
        line = format_aux_declaration(entry)
        if line not in lines:
            lines.append(line)

    opt = config.get("opt") or {}
    display_steps = opt.get("displaysteps") or opt.get("displaySteps")
    if display_steps:
        lines.append(
            "displaysteps(" + str(display_steps["steps"]) + ", " + value_to_text(display_steps["position"]) + ")"
        )
    display_cents = opt.get("displaycents") or opt.get("displayCents")
    if display_cents:
        reference = display_cents.get("reference", display_cents.get("mode", "nominal"))
        lines.append(
            "displaycents("
            + value_to_text(reference) + ", "
            + str(display_cents["precision"]) + ", "
            + value_to_text(display_cents["position"]) + ")"
        )
    if opt.get("explicit"):
        lines.append("explicit()")
    if opt.get("nobold"):
        lines.append("nobold()")

    sec = config.get("sec") or []
    if sec:
        lines.append("sec()")
        for entry in sort_secondary_entries(sec):
            if "text" in entry and entry["text"] is not None:
                lines.append(
                    escape_text_accidental(entry["text"])
                    + " "
                    + value_to_text(entry["symbol"])
                    + " "
                    + format_step_list(first_defined(entry, ("step", "tuning", "cents")))
                )
            else:
                lines.append(
                    value_to_text(entry["symbol"])
                    + " "
                    + format_step_list(first_defined(entry, ("step", "tuning", "cents")))
                )

    return "\n".join(lines) + "\n"


def first_defined(mapping, keys):
    for key in keys:
        if key in mapping and mapping[key] is not None:
            return mapping[key]
    raise ConversionError("missing one of: " + ", ".join(keys))


def discover_inputs(paths, mode, recursive):
    suffixes = {
        "txt-to-json": {".txt"},
        "json-to-txt": {".json"},
        "auto": {".txt", ".json"},
    }[mode]
    files = []
    for raw_path in paths:
        path = Path(raw_path)
        if path.is_dir():
            iterator = path.rglob("*") if recursive else path.glob("*")
            files.extend(sorted(item for item in iterator if item.is_file() and item.suffix.lower() in suffixes))
        elif path.is_file():
            if path.suffix.lower() not in suffixes:
                raise ConversionError("input has unsupported suffix for " + mode + ": " + str(path))
            files.append(path)
        else:
            raise ConversionError("input not found: " + str(path))
    return files


def output_path_for(input_path, output_dir, target_suffix):
    if output_dir is None:
        return input_path.with_suffix(target_suffix)
    try:
        relative = input_path.resolve().relative_to(Path.cwd().resolve())
    except ValueError:
        relative = Path(input_path.name)
    return Path(output_dir) / relative.with_suffix(target_suffix)


def convert_file(input_path, mode, output_dir, force, dry_run, indent):
    suffix = input_path.suffix.lower()
    direction = mode
    if direction == "auto":
        direction = "txt-to-json" if suffix == ".txt" else "json-to-txt"

    target_suffix = ".json" if direction == "txt-to-json" else ".txt"
    output_path = output_path_for(input_path, output_dir, target_suffix)
    if output_path.exists() and not force:
        raise ConversionError("output exists, use --force to overwrite: " + str(output_path))

    if dry_run:
        return output_path

    source_text = input_path.read_text(encoding="utf-8")
    if direction == "txt-to-json":
        converted = compact_json_from_txt(source_text, input_path.stem)
        output_text = json.dumps(converted, ensure_ascii=False, indent=indent) + "\n"
    else:
        converted = json.loads(source_text)
        output_text = compact_json_to_txt(converted)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(output_text, encoding="utf-8")
    return output_path


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["txt-to-json", "json-to-txt", "auto"])
    parser.add_argument("inputs", nargs="+", help="files or directories to convert")
    parser.add_argument("--out-dir", help="write converted files under this directory, mirroring cwd-relative paths")
    parser.add_argument("--recursive", action="store_true", help="scan directory inputs recursively")
    parser.add_argument("--force", action="store_true", help="overwrite existing output files")
    parser.add_argument("--dry-run", action="store_true", help="print planned conversions without writing")
    parser.add_argument("--indent", type=int, default=2, help="JSON indentation for txt-to-json output")
    args = parser.parse_args(argv)

    try:
        inputs = discover_inputs(args.inputs, args.mode, args.recursive)
    except ConversionError as exc:
        print("error: " + str(exc), file=sys.stderr)
        return 2

    failures = 0
    for input_path in inputs:
        try:
            output_path = convert_file(
                input_path,
                args.mode,
                args.out_dir,
                args.force,
                args.dry_run,
                args.indent,
            )
            verb = "would convert" if args.dry_run else "converted"
            print(verb + ": " + str(input_path) + " -> " + str(output_path))
        except Exception as exc:
            failures += 1
            print("failed: " + str(input_path) + ": " + str(exc), file=sys.stderr)

    if failures:
        print(str(failures) + " file(s) failed", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
