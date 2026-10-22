export interface Addon { id: string; name: string; priceCents: number; available: boolean }
export interface AddonGroup { id: string; name: string; minSelect: number; maxSelect: number; addons: Addon[] }
export interface Product {
  id: string; name: string; description: string; imageUrl: string | null; priceCents: number; effectivePriceCents: number;
  promo: { priceCents: number; endsAt: string | null } | null; available: boolean; stockLeft: number | null; addonGroups: AddonGroup[];
}
export interface Category { id: string; name: string; description: string; products: Product[] }
export interface Neighborhood { id: string; name: string; city: string; feeCents: number; minOrderCents: number | null }
export interface StoreInfo {
  name: string; tagline: string; logoUrl: string | null; phone: string; whatsapp: string; address: string; menuMessage: string;
  deliveryInstructions: string; privacyContact: string; minOrderCents: number; eta: { min: number; max: number };
  payments: { cash: boolean; pix: boolean; card: boolean; pixInstructions: string }; open: boolean; closedMessage: string | null;
  nextOpening: string | null; hours: { weekday: number; day: string; opensAt: string; closesAt: string }[]; neighborhoods: Neighborhood[];
}
export interface CartLine {
  lineId: string; productId: string; name: string; quantity: number; notes: string;
  addonIds: string[]; addonNames: string[]; unitCents: number; // exibição; o servidor recalcula
}
