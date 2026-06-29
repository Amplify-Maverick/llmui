"""
LLMUI Bridge — Blender Addon

Runs a lightweight HTTP server inside Blender on port 6000 so that
LLMUI's blender_execute tool can send Python scripts for execution.

Install: Blender → Edit → Preferences → Add-ons → Install → select this file
Enable: check the checkbox next to "LLMUI Bridge"

The server accepts POST /execute with JSON body {"code": "<python>"}
and returns {"ok": true, "result": {...}} or {"ok": false, "error": "..."}.

Store any values you want back in a dict named `result` inside your script.
`bpy` is available without import. Example:
  result['cube'] = bpy.ops.mesh.primitive_cube_add()
"""

bl_info = {
    "name": "LLMUI Bridge",
    "author": "LLMUI",
    "version": (1, 0, 0),
    "blender": (3, 0, 0),
    "location": "Properties > Scene > LLMUI Bridge",
    "description": "HTTP bridge so LLMUI can execute Python scripts inside Blender",
    "category": "Development",
}

import bpy
import json
import threading
import traceback
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 6000
_server: HTTPServer | None = None
_thread: threading.Thread | None = None


class LLMUIHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Suppress default request logging to keep Blender console clean
        pass

    def _send_json(self, status: int, payload: dict):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {"ok": True, "blender": bpy.app.version_string})
        else:
            self._send_json(404, {"ok": False, "error": "Not found"})

    def do_POST(self):
        if self.path != "/execute":
            self._send_json(404, {"ok": False, "error": "Not found"})
            return

        try:
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            data = json.loads(body)
        except Exception as exc:
            self._send_json(400, {"ok": False, "error": f"Bad request: {exc}"})
            return

        code = data.get("code", "")
        if not code:
            self._send_json(400, {"ok": False, "error": "code is required"})
            return

        result = {}
        namespace = {"bpy": bpy, "result": result}

        def run_in_main():
            try:
                exec(compile(code, "<llmui>", "exec"), namespace)
            except Exception:
                namespace["__error__"] = traceback.format_exc()

        # Blender's bpy context must be accessed from the main thread.
        # We schedule execution via a one-shot timer and block until done.
        done = threading.Event()

        def timer_cb():
            run_in_main()
            done.set()
            return None  # returning None removes the timer

        bpy.app.timers.register(timer_cb, first_interval=0.0)
        done.wait(timeout=25)

        if "__error__" in namespace:
            self._send_json(200, {"ok": False, "error": namespace["__error__"]})
        else:
            # Serialize result — convert non-serializable values to str
            try:
                serialized = json.loads(json.dumps(result, default=str))
            except Exception as exc:
                serialized = {"serialization_error": str(exc)}
            self._send_json(200, {"ok": True, "result": serialized})


def start_server():
    global _server, _thread
    if _server is not None:
        return
    _server = HTTPServer(("127.0.0.1", PORT), LLMUIHandler)
    _thread = threading.Thread(target=_server.serve_forever, daemon=True)
    _thread.start()
    print(f"[LLMUI Bridge] Listening on http://127.0.0.1:{PORT}")


def stop_server():
    global _server, _thread
    if _server:
        _server.shutdown()
        _server = None
        _thread = None
        print("[LLMUI Bridge] Stopped")


# ─── Blender UI ──────────────────────────────────────────────────────────────

class LLMUI_PT_panel(bpy.types.Panel):
    bl_label = "LLMUI Bridge"
    bl_idname = "LLMUI_PT_panel"
    bl_space_type = "PROPERTIES"
    bl_region_type = "WINDOW"
    bl_context = "scene"

    def draw(self, context):
        layout = self.layout
        running = _server is not None
        layout.label(
            text=f"Status: {'Running on port ' + str(PORT) if running else 'Stopped'}",
            icon="CHECKMARK" if running else "X",
        )
        if running:
            layout.operator("llmui.stop_server", text="Stop Bridge", icon="PAUSE")
        else:
            layout.operator("llmui.start_server", text="Start Bridge", icon="PLAY")


class LLMUI_OT_start(bpy.types.Operator):
    bl_idname = "llmui.start_server"
    bl_label = "Start LLMUI Bridge"

    def execute(self, context):
        start_server()
        return {"FINISHED"}


class LLMUI_OT_stop(bpy.types.Operator):
    bl_idname = "llmui.stop_server"
    bl_label = "Stop LLMUI Bridge"

    def execute(self, context):
        stop_server()
        return {"FINISHED"}


_classes = [LLMUI_PT_panel, LLMUI_OT_start, LLMUI_OT_stop]


def register():
    for cls in _classes:
        bpy.utils.register_class(cls)
    start_server()


def unregister():
    stop_server()
    for cls in reversed(_classes):
        bpy.utils.unregister_class(cls)
