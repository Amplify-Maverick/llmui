"""Unit tests for sd-fetch's validators: python3 -m unittest deploy/sd-fetch/test_sd_fetch.py"""
import importlib.util
import errno
import json
import os
import shutil
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest import mock

_spec = importlib.util.spec_from_file_location("sd_fetch", os.path.join(os.path.dirname(__file__), "sd-fetch.py"))
sf = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sf)


class Validators(unittest.TestCase):
    def test_repo(self):
        self.assertEqual(sf.validate_repo("city96/FLUX.1-dev-gguf"), "city96/FLUX.1-dev-gguf")
        for bad in ["", "noslash", "a/b/c", "../x", "a/..", "a/.x", "-a/b", "a/b?x", None, 5]:
            self.assertRaises(sf.Reject, sf.validate_repo, bad)

    def test_revision(self):
        self.assertEqual(sf.validate_revision(None), "main")
        self.assertEqual(sf.validate_revision("3c60ac659f4b1f2ab3ca8bd4488272069b36a148"), "3c60ac659f4b1f2ab3ca8bd4488272069b36a148")
        for bad in ["refs/pr/1", "..", "a..b", "-x", "a b"]:
            self.assertRaises(sf.Reject, sf.validate_revision, bad)

    def test_repo_path(self):
        self.assertEqual(sf.validate_repo_path("sub dir/model (1).safetensors"), "sub dir/model (1).safetensors")
        for bad in ["/abs.gguf", "../x.gguf", "a/../x.gguf", "a//x.gguf", "./x.gguf", "x.ckpt", "x.bin",
                    "x.safetensors.part", "a\\b.gguf", "a\nb.gguf", ""]:
            self.assertRaises(sf.Reject, sf.validate_repo_path, bad)

    def test_category(self):
        self.assertEqual(sf.validate_category("checkpoints"), "checkpoints")
        for bad in ["tokenizers", "recipes", "../checkpoints", "Checkpoints", "", None]:
            self.assertRaises(sf.Reject, sf.validate_category, bad)

    def test_sanitize(self):
        self.assertEqual(sf.sanitize_filename("model (v2).safetensors"), "model__v2_.safetensors")
        self.assertEqual(sf.sanitize_filename("flux1-dev-Q4_K_S.gguf"), "flux1-dev-Q4_K_S.gguf")
        for bad in ["..safetensors", "a..b.gguf", ".hidden.gguf", "x.ckpt", "", "x" * 300 + ".gguf"]:
            self.assertRaises(sf.Reject, sf.sanitize_filename, bad)

    def test_resolve_url(self):
        self.assertEqual(
            sf.resolve_url("a/b", "main", "dir/my file#1.gguf"),
            "https://huggingface.co/a/b/resolve/main/dir/my%20file%231.gguf",
        )

    def test_redirects(self):
        self.assertTrue(sf.redirect_allowed("https://us.aws.cdn.hf.co/xet-bridge-us/x"))
        self.assertTrue(sf.redirect_allowed("https://cdn-lfs.huggingface.co/x"))
        self.assertTrue(sf.redirect_allowed("https://huggingface.co/api/resolve-cache/x"))
        for bad in ["http://us.aws.cdn.hf.co/x", "https://evil.com/x", "https://hf.co.evil.com/x",
                    "https://evilhf.co/x", "https://huggingface.co.evil.com/x"]:
            self.assertFalse(sf.redirect_allowed(bad), bad)

    def test_fits(self):
        GiB = sf.GiB
        self.assertTrue(sf.fits(20 * GiB, 10 * GiB, 10 * GiB))
        self.assertFalse(sf.fits(20 * GiB, 10 * GiB, 10 * GiB + 1))


class NvidiaCsv(unittest.TestCase):
    def test_parse(self):
        rows = sf.parse_nvidia_csv(
            "0, NVIDIA GeForce RTX 3070, 54, 37, 6120, 8192, 112.45\n"
            "1, Some GPU, [N/A], [Not Supported], 10, 8192, [N/A]\n\n"
        )
        self.assertEqual(rows[0], {
            "index": 0, "name": "NVIDIA GeForce RTX 3070", "vendor": "nvidia", "state": "active", "temp_c": 54,
            "util_pct": 37, "vram_used_mib": 6120, "vram_total_mib": 8192, "power_w": 112.5,
        })
        self.assertEqual((rows[1]["temp_c"], rows[1]["util_pct"], rows[1]["power_w"]), (None, None, None))
        self.assertEqual(sf.parse_nvidia_csv("garbage\n"), [])


class AmdSysfs(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root)

    def card(self, n, files):
        for rel, text in files.items():
            path = os.path.join(self.root, "card%d" % n, "device", rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as f:
                f.write(text + "\n")

    def test_full(self):
        self.card(0, {
            "mem_info_vram_total": str(8 * 1024 ** 3),
            "mem_info_vram_used": str(3 * 1024 ** 3 + 512 * 1024 ** 2),
            "gpu_busy_percent": "42",
            "uevent": "DRIVER=amdgpu\nPCI_ID=1002:67DF",
            "hwmon/hwmon3/temp1_input": "61000",
            "hwmon/hwmon3/power1_average": "93123000",
            "power/runtime_status": "active",
        })
        os.makedirs(os.path.join(self.root, "card0-DP-1"))  # connectors are skipped
        self.assertEqual(sf.amd_gpus(self.root), [{
            "index": 0, "name": "Radeon RX 470/480/570/580", "vendor": "amd", "state": "active", "temp_c": 61,
            "util_pct": 42, "vram_used_mib": 3584, "vram_total_mib": 8192, "power_w": 93.1,
        }])

    def test_missing_values_are_null(self):
        self.card(1, {"mem_info_vram_total": str(4 * 1024 ** 3), "product_name": "Radeon Test",
                      "hwmon/hwmon0/power1_input": "50000000"})
        self.card(2, {"uevent": "DRIVER=i915"})  # no VRAM info: not amdgpu
        gpus = sf.amd_gpus(self.root)
        self.assertEqual(len(gpus), 1)
        g = gpus[0]
        self.assertEqual((g["name"], g["vram_total_mib"], g["power_w"]), ("Radeon Test", 4096, 50.0))
        self.assertEqual((g["temp_c"], g["util_pct"], g["vram_used_mib"]), (None, None, None))
        self.assertEqual(sf.amd_gpus(os.path.join(self.root, "nope")), [])

    RX580 = {
        "mem_info_vram_total": str(8 * 1024 ** 3),
        "mem_info_vram_used": str(256 * 1024 ** 2),
        "uevent": "DRIVER=amdgpu\nPCI_ID=1002:67DF",
        "gpu_busy_percent": "100",
        "hwmon/hwmon0/temp1_input": "42000",
        "hwmon/hwmon0/power1_input": "143301000",  # RX 580: no power1_average
    }

    def test_active_rx580_uses_power1_input(self):
        self.card(0, dict(self.RX580, **{"power/runtime_status": "active"}))
        g = sf.amd_gpus(self.root)[0]
        self.assertEqual((g["state"], g["temp_c"], g["util_pct"], g["power_w"], g["vram_used_mib"]),
                         ("active", 42, 100, 143.3, 256))

    def test_asleep_reads_only_vram(self):
        self.card(0, dict(self.RX580, **{"power/runtime_status": "suspended"}))
        os.makedirs(os.path.join(self.root, "card0-DP-1", "device"))
        opened = []
        real_open = open

        def spy(path, *a, **kw):
            opened.append(path)
            return real_open(path, *a, **kw)

        with mock.patch("builtins.open", spy):
            gpus = sf.amd_gpus(self.root)
        self.assertEqual(len(gpus), 1)
        g = gpus[0]
        self.assertEqual((g["state"], g["temp_c"], g["util_pct"], g["power_w"]), ("asleep", None, None, None))
        self.assertEqual((g["vram_used_mib"], g["vram_total_mib"]), (256, 8192))
        touched = [p for p in opened if "hwmon" in p or "gpu_busy_percent" in p]
        self.assertEqual(touched, [], "sensors must not be read while the card is asleep")

    def test_ebusy_sensor_is_null_alone(self):
        self.card(0, dict(self.RX580, **{"power/runtime_status": "active"}))
        real_open = open

        def busy_temp(path, *a, **kw):
            if path.endswith("temp1_input") or path.endswith("gpu_busy_percent"):
                raise OSError(errno.EBUSY, "Device or resource busy", path)
            return real_open(path, *a, **kw)

        with mock.patch("builtins.open", busy_temp):
            g = sf.amd_gpus(self.root)[0]
        self.assertEqual((g["state"], g["temp_c"], g["util_pct"], g["power_w"], g["vram_used_mib"]),
                         ("active", None, None, 143.3, 256))

    def test_no_runtime_status_is_active(self):
        self.card(0, self.RX580)
        self.assertEqual(sf.amd_gpus(self.root)[0]["state"], "active")


class InitEnv(unittest.TestCase):
    def test_fills_empty_token_once(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        path = os.path.join(d, "fetch.env")
        with open(path, "w") as f:
            f.write("# comment\nSD_FETCH_TOKEN=\nHF_TOKEN=\n")
        os.chmod(path, 0o600)
        self.assertTrue(sf.init_env_token(path))
        text = open(path).read()
        token = [l for l in text.splitlines() if l.startswith("SD_FETCH_TOKEN=")][0][15:]
        self.assertRegex(token, r"^[0-9a-f]{64}$")
        self.assertIn("HF_TOKEN=\n", text)
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
        self.assertFalse(sf.init_env_token(path))  # never rotates
        self.assertEqual(open(path).read(), text)


class GpuEndpoint(unittest.TestCase):
    TOKEN = "t" * 40

    def setUp(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        cfg = sf.Config({"SD_FETCH_TOKEN": self.TOKEN, "SD_MODEL_DIR": d, "SD_FETCH_GPU": "none"})
        self.httpd = sf.Server(("127.0.0.1", 0), sf.make_handler(cfg, sf.Downloader(cfg)))
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)
        self.url = "http://127.0.0.1:%d/v1/gpu" % self.httpd.server_address[1]

    def get(self, token):
        req = urllib.request.Request(self.url, headers={"Authorization": "Bearer " + token} if token else {})
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read())

    def test_requires_token(self):
        with self.assertRaises(urllib.error.HTTPError) as cm:
            self.get(None)
        self.assertEqual(cm.exception.code, 401)

    def test_disabled(self):
        status, body = self.get(self.TOKEN)
        self.assertEqual(status, 200)
        self.assertEqual(body["gpus"], [])
        self.assertIsNone(body["source"])
        self.assertIn("disabled", body["error"])


if __name__ == "__main__":
    unittest.main()
