import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { badRequest } from './errors.js';

export const uploadRoot = () => path.resolve(config.UPLOAD_DIR);
export type ImageFolder = 'products' | 'store' | 'reviews';

// Valida decodificando de verdade, corrige a rotação, redimensiona e converte para WebP.
export async function processImage(buf: Buffer, maxSize: number): Promise<Buffer> {
  try {
    return await sharp(buf).rotate().resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  } catch {
    throw badRequest('invalid_image', 'Arquivo de imagem inválido. Use JPG, PNG ou WebP.');
  }
}

// Grava no banco: sobrevive a reinícios em hospedagens com disco temporário.
export async function storeImage(folder: ImageFolder, webp: Buffer): Promise<string> {
  const rel = `${folder}/${randomUUID()}.webp`;
  await pool.query('INSERT INTO stored_images (path, content, content_type) VALUES ($1,$2,$3)', [rel, webp, 'image/webp']);
  return rel;
}

// Recebe uma imagem (multipart com um arquivo), processa e grava.
export async function saveImage(req: FastifyRequest, folder: ImageFolder, maxSize: number): Promise<string> {
  const file = await req.file({ limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
  if (!file) throw badRequest('file_required', 'Envie uma imagem.');
  const buf = await file.toBuffer();
  if (file.file.truncated) throw badRequest('file_too_large', 'Imagem maior que 8 MB.');
  return storeImage(folder, await processImage(buf, maxSize));
}

export async function removeImage(rel: string | null) {
  if (!rel || rel.includes('..')) return;
  await pool.query('DELETE FROM stored_images WHERE path = $1', [rel]).catch(() => {});
  await import('node:fs/promises').then((fs) => fs.unlink(path.join(uploadRoot(), rel))).catch(() => {});
}

// Lê do banco; imagens antigas (gravadas em disco antes desta versão) ainda são servidas do disco.
export async function loadImage(rel: string): Promise<{ content: Buffer; contentType: string } | null> {
  if (!/^(products|store|reviews)\/[A-Za-z0-9-]+\.(webp|png|jpe?g)$/.test(rel)) return null;
  const r = await pool.query('SELECT content, content_type FROM stored_images WHERE path = $1', [rel]);
  if (r.rows[0]) return { content: r.rows[0].content, contentType: r.rows[0].content_type };
  try {
    const content = await readFile(path.join(uploadRoot(), rel));
    return { content, contentType: rel.endsWith('.webp') ? 'image/webp' : rel.endsWith('.png') ? 'image/png' : 'image/jpeg' };
  } catch {
    return null;
  }
}
