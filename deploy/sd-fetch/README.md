# sd-fetch

Downloads Hugging Face model files into sd-server's `--model-dir`
(`/var/lib/sd/models`) for LLMUI's **Models → Image** tab, and reports the
host's GPU stats (`GET /v1/gpu`) for the System page. It runs on each sd-server
host as `llama` on port 8083 and needs a shared bearer token. Python 3.7+
standard library only.

## Jellyfin (default machine, RX 580)

Listens on `100.118.190.15:8083`; an nft table limits the port to the box.

| File | Installed as |
| --- | --- |
| `sd-fetch.py` | `/opt/sd-fetch/sd-fetch.py` |
| `sd-fetch.service` | `/etc/systemd/system/sd-fetch.service` |
| `sdfetch-guard.nft` | `/etc/sd/sdfetch-guard.nft` (loaded by the unit's `ExecStartPre`) |
| `fetch.env.example` | `/etc/sd/fetch.env` (root:root 0600) |

LLMUI keeps its copy of the token in `~/.llmui/sd-fetch.token` (mode 0600) and
the helper URL in `fetchUrl` of `~/.llmui/sd_config.json` (default
`http://100.118.190.15:8083`). The browser never sees the token.

## Workstation (RTX 3070, Arch)

Listens on `100.126.189.91:8083` through a systemd socket unit. There is no
nft on this host, so the socket unit restricts who can connect, with
`IPAddressDeny=any` and `IPAddressAllow=localhost 100.126.189.91 100.101.246.7`.
Those lines are on the socket, not the service: on the service they would
also block the helper's own outbound connections to Hugging Face. ufw also
allows only the box on 8083.

| File | Installed as |
| --- | --- |
| `sd-fetch.py` | `/opt/sd-fetch/sd-fetch.py` |
| `workstation/sd-fetch.socket` | `/etc/systemd/system/sd-fetch.socket` (the unit to enable) |
| `workstation/sd-fetch.service` | `/etc/systemd/system/sd-fetch.service` |
| `workstation/fetch.env` | `/etc/sd/fetch.env` (root:root 0600) |

Fill the token with `sudo python3 -I /opt/sd-fetch/sd-fetch.py --init-env /etc/sd/fetch.env`.
That only fills an empty `SD_FETCH_TOKEN=` line and never prints the token.
LLMUI reads its copy from `~/.llmui/workstation-fetch.token`, and the helper
URL from `fetchUrl` in `~/.llmui/sd_config.workstation.json`.

## GPU stats

`GET /v1/gpu` answers `{source, error, gpus: [{index, name, vendor, temp_c,
util_pct, vram_used_mib, vram_total_mib, power_w}]}`, cached for 1 s. A value
it can't read is `null`. `SD_FETCH_GPU` picks the source:

- `auto` (default): nvidia-smi if it is installed, else amdgpu sysfs.
- `nvidia`: `nvidia-smi --query-gpu=... --format=csv,noheader,nounits`.
- `amd`: `/sys/class/drm/cardN/device/` `mem_info_vram_used`/`_total`,
  `gpu_busy_percent`, `hwmon/*/temp1_input`, and `power1_average` (or
  `power1_input`).
- `none`: disabled.

`SD_FETCH_GPU_NAME` overrides the reported name.

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
GET    /v1/gpu
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
