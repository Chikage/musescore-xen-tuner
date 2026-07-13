# pyTen sKriPz

These scripts are not part of the plugin, but they are here to help make the development process easier by auto-generating repeated code & tuning configs.

These skripz are designed to run from the context of the project root.

That is, `pwd` should point to the `musescore-xen-tuner/` folder, instead of the `tools/dev/` folder.

## Tuning config conversion

`convert-tuning-configs.py` batch-converts between legacy `.txt` tuning configs and compact JSON tuning configs:

```sh
python tools/dev/convert-tuning-configs.py txt-to-json tunings/26edo.txt --out-dir tmp
python tools/dev/convert-tuning-configs.py json-to-txt tunings/26edo.json --out-dir tmp
python tools/dev/convert-tuning-configs.py auto tunings --recursive --out-dir tmp
```

Use `--dry-run` to preview output paths and `--force` to overwrite existing converted files.
