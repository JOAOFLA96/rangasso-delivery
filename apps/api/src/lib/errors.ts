// Erro de negócio com código estável (o frontend usa o código; a mensagem é exibida ao usuário).
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Registro') => new AppError(404, 'not_found', `${what} não encontrado.`);
export const forbidden = () => new AppError(403, 'forbidden', 'Você não tem permissão para esta ação.');
export const unauthorized = () => new AppError(401, 'unauthorized', 'Faça login para continuar.');
export const badRequest = (code: string, message: string, details?: unknown) => new AppError(400, code, message, details);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
