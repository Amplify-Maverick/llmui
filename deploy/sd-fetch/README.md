# sd-fetch

Downloads Hugging Face model files into sd-server's `--model-dir`
(`/var/lib/sd/models`) for LLMUI's **Models → Image** tab. It runs on the
sd-server host as `llama`, listens on `100.118.190.15:8083`, and needs a
shared bearer token. Python 3.7+ standard library only.

| File | Installed as |
| --- | --- |
| `sd-fetch.py` | `/opt/sd-fetch/sd-fetch.py` |
| `sd-fetch.service` | `/etc/systemd/system/sd-fetch.service` |
| `sdfetch-guard.nft` | `/etc/sd/sdfetch-guard.nft` (loaded by the unit's `ExecStartPre`) |
| `fetch.env.example` | `/etc/sd/fetch.env` (root:root 0600) |

LLMUI keeps its copy of the token in `~/.llmui/sd-fetch.token` (mode 0600) and
the helper URL in `fetchUrl` of `~/.llmui/sd_config.json` (default
`http://100.118.190.15:8083`). The browser never sees the token.

## What it enforces

- Only `https://huggingface.co/<repo>/resolve/<revision>/<path>`; redirects
  only to `*.hf.co` / `*.huggingface.co` over https. `HF_TOKEN` is sent to
  `huggingface.co` only.
- Only `.safetensors` and `.gguf`. Category must be one of sd-server's model
  folders: `checkpoints diffusion_models text_encoders vae clip_vision
  controlnet ipadapter motion_modules photomaker pulid loras`.
- File names: characters outside `[A-Za-z0-9._+-]` become `_`; names with `/`,
  `..` or a leading dot are refused. Existing files are never overwritten.
- Writes `.<name>.<hash>.part` in the category folder, checks size and the
  SHA-256 Hugging Face reports, then links it into place. A failed download
  keeps its `.part` and resumes on retry; cancel deletes it.
- Refuses a download that would leave less than `SD_FETCH_RESERVE_GB` (10) free.
- One download at a time.

## sd-server and new files

sd-server (532d2c1) lists files from a catalog it scans at startup; a new or
deleted file shows up after `POST /sdcpp/v1/models/refresh` (the web UI's
"Refresh files & recipes"). No restart is needed. LLMUI calls refresh when a
download completes, after a delete, and whenever it lists image models.

## API

All requests need `Authorization: Bearer <SD_FETCH_TOKEN>`.

```
GET    /v1/health
GET    /v1/disk
GET    /v1/files
DELETE /v1/files/<category>/<name>
POST   /v1/downloads            {"repo","path","revision","category"}
GET    /v1/downloads/current
GET    /v1/downloads/<id>
POST   /v1/downloads/<id>/cancel
```

## Tests

```
python3 -m unittest deploy/sd-fetch/test_sd_fetch.py
```
