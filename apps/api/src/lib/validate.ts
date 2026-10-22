import type { ZodType } from 'zod';
import { AppError } from './errors.js';

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    const fields = r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    throw new AppError(400, 'validation_error', 'Confira os dados informados.', { fields });
  }
  return r.data;
}
