// KTX2 files for the full-size texture set (pack-textures), through the Basis Universal encoder
// that ktx2-encoder builds to WebAssembly, so no native tool (basisu, toktx) is needed.
//
// ETC1S, not UASTC: a 1024² facade is 215 KB with its mipmaps where UASTC (with RDO and zstd)
// was 808 KB, and ETC1S transcodes losslessly to ETC2 where the GPU has it. Each layer is a
// file of its own: this encoder caps a file at 12 Mpix, under a dozen 1024² layers, and the
// app stacks the layers into array textures itself (src/textures.ts).

import * as ktx2Encoder from "ktx2-encoder";
import type { IBasisModule } from "ktx2-encoder";
import sharp from "sharp";

// Node resolves the package to its Node build, which has the encoder class; the type checker
// follows the browser build's types, which don't list it.
const { NodeBasisEncoder } = ktx2Encoder as unknown as { NodeBasisEncoder: new () => { init(): Promise<IBasisModule> } };
let basis: Promise<IBasisModule> | null = null;

/** An sRGB colour image as KTX2: ETC1S at `quality` (1–255), with a full mip chain. */
export async function encodeKtx2(image: string | Buffer, quality = 255): Promise<Uint8Array> {
  const m = await (basis ??= new NodeBasisEncoder().init());
  const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const e = new m.BasisEncoder();
  try {
    e.setCreateKTX2File(true);
    e.setTexType(0); // 2D
    e.setUASTC(false);
    e.setQualityLevel(quality);
    e.setETC1SCompressionLevel?.(2);
    e.setMipGen(true);
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
