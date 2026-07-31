/**
 * ComfyUI workflow graph templates.
 *
 * Each builder returns a JSON-serialisable object that ComfyUI accepts via
 * POST /prompt.  The graph is a flat map of node-id → node-config.
 *
 * Node IDs are strings (ComfyUI convention).  We use simple numeric IDs.
 */

/**
 * Build a standard txt2img workflow.
 *
 * Nodes:
 *   1 – CheckpointLoaderSimple
 *   2 – CLIPTextEncode (positive)
 *   3 – CLIPTextEncode (negative)
 *   4 – EmptyLatentImage
 *   5 – KSampler
 *   6 – VAEDecode
 *   7 – SaveImage
 *
 * @param {object} params
 * @param {string} params.checkpoint   – checkpoint filename
 * @param {string} params.prompt       – positive prompt text
 * @param {string} params.negativePrompt – negative prompt text
 * @param {number} params.width
 * @param {number} params.height
 * @param {number} params.steps
 * @param {number} params.cfgScale
 * @param {string} params.sampler      – sampler_name (e.g. "euler")
 * @param {string} params.scheduler    – scheduler (e.g. "normal")
 * @param {number} params.seed         – -1 for random
 * @param {number} params.batchCount   – batch size
 * @returns {object}                   – { prompt: {...nodes} }
 */
export function buildTxt2ImgWorkflow(params) {
  const {
    checkpoint,
    prompt,
    negativePrompt = "",
    width = 512,
    height = 512,
    steps = 20,
    cfgScale = 7,
    sampler = "euler",
    scheduler = "normal",
    seed = -1,
    batchCount = 1,
  } = params;

  const actualSeed = seed === -1 ? Math.floor(Math.random() * 2 ** 32) : seed;

  return {
    prompt: {
      "1": {
        class_type: "CheckpointLoaderSimple",
        inputs: {
          ckpt_name: checkpoint,
        },
      },
      "2": {
        class_type: "CLIPTextEncode",
        inputs: {
          text: prompt,
          clip: ["1", 1], // CLIP output from checkpoint loader
        },
      },
      "3": {
        class_type: "CLIPTextEncode",
        inputs: {
          text: negativePrompt,
          clip: ["1", 1],
        },
      },
      "4": {
        class_type: "EmptyLatentImage",
        inputs: {
          width,
          height,
          batch_size: batchCount,
        },
      },
      "5": {
        class_type: "KSampler",
        inputs: {
          model: ["1", 0], // MODEL output from checkpoint loader
          positive: ["2", 0],
          negative: ["3", 0],
          latent_image: ["4", 0],
          seed: actualSeed,
          steps,
          cfg: cfgScale,
          sampler_name: sampler,
          scheduler,
          denoise: 1.0,
        },
      },
      "6": {
        class_type: "VAEDecode",
        inputs: {
          samples: ["5", 0], // LATENT output from KSampler
          vae: ["1", 2],     // VAE output from checkpoint loader
        },
      },
      "7": {
        class_type: "SaveImage",
        inputs: {
          images: ["6", 0],
          filename_prefix: "llmui",
        },
      },
    },
    _meta: {
      seed: actualSeed,
    },
  };
}

/**
 * Build an img2img workflow.
 *
 * Nodes:
 *   1  – CheckpointLoaderSimple
 *   2  – CLIPTextEncode (positive)
 *   3  – CLIPTextEncode (negative)
 *   4  – LoadImage
 *   5  – VAEEncode
 *   6  – KSampler
 *   7  – VAEDecode
 *   8  – SaveImage
 *
 * @param {object} params
 * @param {string} params.checkpoint
 * @param {string} params.prompt
 * @param {string} params.negativePrompt
 * @param {number} params.steps
 * @param {number} params.cfgScale
 * @param {string} params.sampler
 * @param {string} params.scheduler
 * @param {number} params.seed
 * @param {number} params.denoise      – denoising strength (0-1)
 * @param {string} params.inputImage   – filename of uploaded image in ComfyUI
 * @returns {object}
 */
export function buildImg2ImgWorkflow(params) {
  const {
    checkpoint,
    prompt,
    negativePrompt = "",
    steps = 20,
    cfgScale = 7,
    sampler = "euler",
    scheduler = "normal",
    seed = -1,
    denoise = 0.75,
    inputImage,
  } = params;

  const actualSeed = seed === -1 ? Math.floor(Math.random() * 2 ** 32) : seed;

  return {
    prompt: {
      "1": {
        class_type: "CheckpointLoaderSimple",
        inputs: {
          ckpt_name: checkpoint,
        },
      },
      "2": {
        class_type: "CLIPTextEncode",
        inputs: {
          text: prompt,
          clip: ["1", 1],
        },
      },
      "3": {
        class_type: "CLIPTextEncode",
        inputs: {
          text: negativePrompt,
          clip: ["1", 1],
        },
      },
      "4": {
        class_type: "LoadImage",
        inputs: {
          image: inputImage,
        },
      },
      "5": {
        class_type: "VAEEncode",
        inputs: {
          pixels: ["4", 0],
          vae: ["1", 2],
        },
      },
      "6": {
        class_type: "KSampler",
        inputs: {
          model: ["1", 0],
          positive: ["2", 0],
          negative: ["3", 0],
          latent_image: ["5", 0],
          seed: actualSeed,
          steps,
          cfg: cfgScale,
          sampler_name: sampler,
          scheduler,
          denoise,
        },
      },
      "7": {
        class_type: "VAEDecode",
        inputs: {
          samples: ["6", 0],
          vae: ["1", 2],
        },
      },
      "8": {
        class_type: "SaveImage",
        inputs: {
          images: ["7", 0],
          filename_prefix: "llmui",
        },
      },
    },
    _meta: {
      seed: actualSeed,
    },
  };
}
