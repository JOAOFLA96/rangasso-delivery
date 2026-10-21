import { mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { badRequest } from './errors.js';

export const uploadRoot = () => path.resolve(config.UPLOAD_DIR);

// Recebe uma imagem, valida decodificando de verdade, redimensiona e salva como WebP.
export async function saveImage(req: FastifyRequest, folder: 'products' | 'store', maxSize: number): Promise<string> {
  const file = await req.file({ limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
  if (!file) throw badRequest('file_required', 'Envie uma imagem.');
  const buf = await file.toBuffer();
  if (file.file.truncated) throw badRequest('file_too_large', 'Imagem maior que 8 MB.');
  let out: Buffer;
  try {
    out = await sharp(buf).rotate().resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  } catch {
    throw badRequest('invalid_image', 'Arquivo de imagem inválido. Use JPG, PNG ou WebP.');
  }
  const rel = `${folder}/${randomUUID()}.webp`;
  await mkdir(path.join(uploadRoot(), folder), { recursive: true });
  await writeFile(path.join(uploadRoot(), rel), out);
  return rel;
}

export async function removeImage(rel: string | null) {
  if (!rel || rel.includes('..')) return;
  await unlink(path.join(uploadRoot(), rel)).catch(() => {});
}
