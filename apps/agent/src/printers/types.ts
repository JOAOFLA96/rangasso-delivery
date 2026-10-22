export interface PrinterStatus {
  online: boolean | null; // null = o driver/conexão não informa
  paperOut?: boolean | null;
  coverOpen?: boolean | null;
  error?: string | null;
}

export interface PrintResult {
  // 'printed': a própria impressora confirmou estado OK depois do envio (rede com status).
  // 'sent': o Windows/destino aceitou os bytes, sem confirmação física.
  outcome: 'printed' | 'sent';
  detail: string;
}

export interface Printer {
  readonly mode: string;
  readonly target: string;
  print(data: Buffer, docName: string): Promise<PrintResult>;
  status(): Promise<PrinterStatus>;
}

// Erro que indica que nada foi impresso (seguro tentar de novo).
export class PrinterError extends Error {
  constructor(message: string, public safeToRetry = true) {
    super(message);
  }
}
