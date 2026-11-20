"""Unit tests for sd-fetch's validators: python3 -m unittest deploy/sd-fetch/test_sd_fetch.py"""
import importlib.util
import os
import unittest

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


if __name__ == "__main__":
    unittest.main()
