/**
 * Blender Execute Tool
 *
 * Sends Python code to the LLMUI Blender addon running inside Blender.
 * The addon must be installed and enabled in Blender first — it starts
 * a local HTTP server on port 6000 that accepts POST /execute requests.
 *
 * Install the addon: Blender → Edit → Preferences → Add-ons → Install
 * then select blender_addon/llmui_bridge.py from this project.
 */

const BLENDER_URL = process.env.BLENDER_BRIDGE_URL || "http://localhost:6000";

const blenderExecute = {
  name: "blender_execute",
  description:
    "Execute a Python script inside Blender via the LLMUI bridge addon. " +
    "Use the `bpy` module to create/modify objects, materials, scenes, etc. " +
    "Store return values in a dict called `result` — it is returned as output. " +
    "Example: result['objects'] = [o.name for o in bpy.data.objects]",
  parameters: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description:
          "Python code to run inside Blender. `bpy` is pre-imported. " +
          "Store any values you want returned in a dict named `result`.",
      },
    },
    required: ["code"],
  },
  handler: async ({ code }) => {
    if (!code || typeof code !== "string") {
      throw new Error("code must be a non-empty string");
    }

    let response;
    try {
      response = await fetch(`${BLENDER_URL}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
        signal: AbortSignal.timeout(30000), // 30s for slow operations
      });
    } catch (err) {
      if (err.name === "TimeoutError") {
        throw new Error("Blender did not respond within 30 seconds");
      }
      throw new Error(
        `Cannot reach Blender bridge at ${BLENDER_URL}. ` +
          "Is the LLMUI bridge addon enabled in Blender? " +
          `(${err.message})`
      );
    }

    const data = await response.json();

    if (!data.ok) {
      throw new Error(`Blender script error: ${data.error}`);
    }

    return data.result ?? {};
  },
};

export default blenderExecute;
