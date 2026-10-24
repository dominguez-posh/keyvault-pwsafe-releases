// Export of a vault's entries as CSV – only when the vault's admin has enabled it (vault settings). Columns follow
// the Bitwarden CSV format so that the file can be imported almost anywhere; card fields are appended.
// Certificate files are not exported (binary), their password is.

const COLUMNS = ['folder', 'favorite', 'type', 'name', 'notes', 'fields', 'login_uri', 'login_username', 'login_password', 'login_totp',
  'card_holder', 'card_number', 'card_expiry', 'card_cvc', 'card_pin', 'certificate_file'];

const cell = (value) => {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function itemsToCsv(items) {
  const rows = items.map((i) => [
    i.folder,
    i.favorite ? 1 : '',
    i.type === 'login' ? 'login' : i.type === 'card' ? 'card' : 'note',
    i.title,
    i.notes,
    (i.fields || []).map((f) => `${f.name}: ${f.value}`).join('\n'),
    (i.urls || []).join(','),
    i.username,
    i.password,
    i.totp,
    i.card?.holder,
    i.card?.number,
    i.card?.expiry,
    i.card?.cvc,
    i.card?.pin,
    i.cert?.fileName,
  ].map(cell).join(','));
  // BOM: Excel opens UTF-8 (umlauts) correctly only with it.
  return `﻿${[COLUMNS.join(','), ...rows].join('\r\n')}\r\n`;
}
