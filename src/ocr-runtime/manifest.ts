/**
 * Ingebouwde tekstherkenning (#8/#9): wat er bij eerste gebruik gedownload wordt.
 *
 * - Model: GLM-OCR 0.9B (zai-org, MIT-licentie), GGUF-conversie van ggml-org (Q8_0 + vision-projector).
 *   Vaste bestanden met vaste sha256: een gewijzigd of beschadigd bestand wordt geweigerd.
 * - Runtime: llama.cpp `llama-server` (MIT), de CPU-build voor dit platform van de nieuwste release.
 *   GitHub geeft per bestand een sha256 (`digest`); die wordt gecontroleerd.
 *
 * Alles draait daarna lokaal op 127.0.0.1; documenten verlaten de computer niet.
 */

export interface ModelFile {
  name: string;
  url: string;
  size: number;
  sha256: string;
}

export interface OcrModel {
  id: string;
  label: string;
  license: string;
  licenseUrl: string;
  files: ModelFile[];
  /** prompt volgens de modelkaart */
  prompt: string;
}

export const GLM_OCR: OcrModel = {
  id: 'glm-ocr',
  label: 'GLM-OCR 0.9B',
  license: 'MIT',
  licenseUrl: 'https://huggingface.co/zai-org/GLM-OCR',
  prompt: 'Text Recognition:',
  files: [
    {
      name: 'GLM-OCR-Q8_0.gguf',
      url: 'https://huggingface.co/ggml-org/GLM-OCR-GGUF/resolve/main/GLM-OCR-Q8_0.gguf',
      size: 950_433_408,
      sha256: '45bc244a6446aff850521dc41f18bc8d7105ad5f0c2c8c28af04e7cc4f4d50b1',
    },
    {
      name: 'mmproj-GLM-OCR-Q8_0.gguf',
      url: 'https://huggingface.co/ggml-org/GLM-OCR-GGUF/resolve/main/mmproj-GLM-OCR-Q8_0.gguf',
      size: 484_403_648,
      sha256: '9c4b58e33e316ed142eb5dcb41abec3844d3e6e5dc361ffb782c3fa9d175141f',
    },
  ],
};

export const LLAMA_CPP = {
  label: 'llama.cpp (llama-server)',
  license: 'MIT',
  licenseUrl: 'https://github.com/ggml-org/llama.cpp/blob/master/LICENSE',
  releaseApi: 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest',
  /** ongeveer, voor de melding vooraf (de precieze grootte volgt uit de release) */
  approxSize: 30_000_000,
};

/** Welk release-bestand van llama.cpp bij dit platform hoort (CPU-build), of null als we het niet ondersteunen. */
export function llamaAssetPattern(platform: string, arch: string): RegExp | null {
  if (platform === 'win32' && arch === 'x64') return /-bin-win-cpu-x64\.zip$/;
  if (platform === 'win32' && arch === 'arm64') return /-bin-win-cpu-arm64\.zip$/;
  if (platform === 'darwin' && arch === 'arm64') return /-bin-macos-arm64\.(zip|tar\.gz)$/;
  if (platform === 'darwin' && arch === 'x64') return /-bin-macos-x64\.(zip|tar\.gz)$/;
  if (platform === 'linux' && arch === 'x64') return /-bin-ubuntu-x64\.(zip|tar\.gz)$/;
  return null;
}

export const DOWNLOAD_SIZE = GLM_OCR.files.reduce((s, f) => s + f.size, 0) + LLAMA_CPP.approxSize;

/** Minimale eisen (CPU, geen videokaart nodig). */
export const REQUIREMENTS = '64-bit Windows 10/11, macOS 12+ of Linux (x64); minstens 4 GB werkgeheugen (8 GB aanbevolen) en 2 GB vrije schijfruimte. Een videokaart is niet nodig. Een bon duurt op een gewone laptop enkele seconden tot een halve minuut.';
