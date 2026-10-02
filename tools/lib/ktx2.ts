// KTX2 files for the full-size texture set (pack-textures), through the Basis Universal encoder
// that ktx2-encoder builds to WebAssembly, so no native tool (basisu, toktx) is needed.
//
// ETC1S for the layers: a 1024² facade is 215 KB with its mipmaps where UASTC (with RDO and
// zstd) was 808 KB, and ETC1S transcodes losslessly to ETC2 where the GPU has it. Each layer is
// a file of its own: this encoder caps a file at 12 Mpix, under a dozen 1024² layers, and the
// app stacks the layers into array textures itself (src/textures.ts). UASTC for the skies:
// ETC1S bands their gradients (40.6 dB on the golden sky, an error of up to 52 in blue), where
// UASTC keeps them (54.3 dB) in 0.9 MB at 4096 × 2048, and transcodes to ASTC or BC7.

import * as ktx2Encoder from "ktx2-encoder";
import type { IBasisModule } from "ktx2-encoder";
import sharp from "sharp";

// Node resolves the package to its Node build, which has the encoder class; the type checker
// follows the browser build's types, which don't list it.
const { NodeBasisEncoder } = ktx2Encoder as unknown as { NodeBasisEncoder: new () => { init(): Promise<IBasisModule> } };
let basis: Promise<IBasisModule> | null = null;

export interface Ktx2Options {
  /** UASTC (with RDO and zstd) rather than ETC1S. */
  uastc?: boolean;
  /** ETC1S quality, 1–255. */
  quality?: number;
  /** A full mip chain (the skies have none: they're magnified almost everywhere). */
  mipmaps?: boolean;
}

/** An sRGB colour image as KTX2: ETC1S at `quality` or UASTC, with a full mip chain by default. */
export async function encodeKtx2(image: string | Buffer, { uastc = false, quality = 255, mipmaps = true }: Ktx2Options = {}): Promise<Uint8Array> {
  const m = await (basis ??= new NodeBasisEncoder().init());
  const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const e = new m.BasisEncoder();
  try {
    e.setCreateKTX2File(true);
    e.setTexType(0); // 2D
    e.setUASTC(uastc);
    if (uastc) {
      e.setPackUASTCFlags(2); // the default level
      e.setRDOUASTC(true);
      e.setRDOUASTCQualityScalar(1);
      e.setKTX2UASTCSupercompression(true);
    } else {
      e.setQualityLevel(quality);
      e.setETC1SCompressionLevel?.(2);
    }
    e.setMipGen(mipmaps);
    e.setPerceptual(true);
    e.setKTX2AndBasisSRGBTransferFunc?.(true);
    e.setDebug(false);
    // Quiet: v2.5 prints every slice it encodes (the method is missing from the package's types).
    (e as { setStatusOutput?: (on: boolean) => void }).setStatusOutput?.(false);
    if (e.setSliceSourceImage(0, new Uint8Array(data), info.width, info.height, 0) === false) throw new Error("KTX2: the encoder refused the image");
    const out = new Uint8Array(info.width * info.height * 2 + 65536);
    const n = e.encode(out);
    if (!n) throw new Error("KTX2: encoding failed");
    return out.slice(0, n);
  } finally {
    e.delete();
  }
}
