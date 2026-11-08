// Moving an entry together with its linked assets (#452): plan (who moves, who cannot, which links get lost) and an
// all-or-nothing execution. Links are stored as "<containerId>/<id>" in server.rdpLink / tvLink / bastionLoginLink /
// bastionVmLink and loginLink (see session.linkedEntries, #451); a moved entry gets a new id in another vault, so its
// links are rewritten to the new keys. Called by the app's window (api "moveWithAssets") and, since #464, for the approved browser
// extension (bridge command "moveWithAssets", desktop/browser-items.js); never by MCP.

import { t } from './i18n.js';
import { newItemId } from './model.js';

const USES = (it) => {
  const sv = it.server || {};
  return Object.entries({ rdp: sv.rdpLink, teamviewer: sv.tvLink, bastionLogin: sv.bastionLoginLink, bastionVm: sv.bastionVmLink, login: it.loginLink })
    .filter(([, key]) => key);
};

/** An error that says what lies where after a failed move. */
export class MoveAssetsError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'MoveAssetsError';
    Object.assign(this, details);
  }
}

/** Why nothing may move from one vault to the other (null = allowed). Needs write access on both sides. */
export function moveRefusal(from, to) {
  if (to.personal && !from.personal) return t('Einträge aus geteilten Tresoren lassen sich nicht in den persönlichen Tresor verschieben');
  if (to.access?.write === false) return t('Im Tresor „{vault}“ fehlt das Schreibrecht', { vault: to.name });
  if (from.access?.write === false) return t('Im Tresor „{vault}“ fehlt das Schreibrecht zum Entfernen der Einträge', { vault: from.name });
  return null;
}

/**
 * What a move of one entry would take along → { refused, members, blocked, dropped }.
 * members: in the order they are created (targets of links first) [{ id, title, type, folder, role }], role
 * "selected" | "user" (uses the selected one) | "linked" (only the moved ones use it).
 * blocked: [{ id, title, reason }] – cannot move; dropped: [{ title, uses }] – links that are lost in the target vault.
 * refused: a text when nothing can move (no write access in the target …); the candidates are then all in blocked.
 */
export async function planMoveWithAssets(session, fromId, toId, id) {
  const [from, to] = await Promise.all([session.container(fromId), session.container(toId)]);
  const cross = fromId !== toId;
  const refused = moveRefusal(from, to);
  const root = await session.getItem(fromId, id, { fresh: true });
  const members = new Map([[id, root]]);
  const role = new Map([[id, 'selected']]);
  const blocked = [];
  const mine = (key) => (key && key.startsWith(`${fromId}/`) ? key.slice(fromId.length + 1) : '');

  // Entries that use a moved one move along (a login in use must not disappear under them, #34).
  for (const queue = [id]; queue.length;) {
    for (const e of await session.linkedEntries(fromId, queue.shift())) {
      if (members.has(e.id)) continue;
      members.set(e.id, await session.getItem(fromId, e.id, { fresh: true }));
      role.set(e.id, 'user');
      queue.push(e.id);
    }
  }
  // What a moved entry links to moves along when nothing else uses it.
  for (let grew = true; grew;) {
    grew = false;
    for (const it of [...members.values()]) {
      for (const [, key] of USES(it)) {
        const tid = mine(key);
        if (!tid || members.has(tid)) continue;
        const users = (await session.linkedEntries(fromId, tid)).map((e) => e.id);
        if (!users.every((u) => members.has(u))) continue;
        const target = await session.getItem(fromId, tid, { fresh: true }).catch(() => null);
        if (!target) continue;
        members.set(tid, target);
        role.set(tid, 'linked');
        grew = true;
      }
    }
  }
  // A linked login has no sign-in of its own: it only moves to another vault together with the entry it links to.
  if (cross) {
    for (let again = true; again;) {
      again = false;
      for (const [mid, it] of [...members]) {
        if (!it.loginLink || members.has(mine(it.loginLink))) continue;
        if (mid === id) {
          // #462: a plan that says why (shown on every move path), not an error before any dialog.
          const reason = t('„{title}“ nutzt die Anmeldung eines anderen Eintrags und lässt sich deshalb nicht in einen anderen Tresor verschieben. Erst die Verknüpfung lösen.', { title: it.title });
          return { refused: reason, members: [], blocked: [{ id: mid, title: it.title, reason }], dropped: [], items: members, order: [] };
        }
        members.delete(mid);
        blocked.push({ id: mid, title: it.title, reason: t('nutzt die Anmeldung eines anderen Eintrags') });
        again = true;
      }
    }
  }
  // Order: what is linked to first.
  const order = [];
  const seen = new Set();
  const visit = (mid, path) => {
    if (seen.has(mid)) return;
    if (path.includes(mid)) throw new Error(t('Die Verknüpfungen von „{title}“ sind zirkulär und lassen sich nicht gemeinsam verschieben', { title: members.get(mid).title }));
    for (const [, key] of USES(members.get(mid))) if (members.has(mine(key))) visit(mine(key), [...path, mid]);
    seen.add(mid);
    order.push(mid);
  };
  for (const mid of members.keys()) visit(mid, []);

  const list = order.map((mid) => ({ id: mid, title: members.get(mid).title, type: members.get(mid).type, folder: members.get(mid).folder || '', role: role.get(mid) }));
  const dropped = [];
  if (cross) {
    for (const mid of order) {
      // A link into a moved entry is rewritten, one into the target vault itself stays; everything else (an entry that
      // stays behind or one in a third vault) is removed from the moved entry: links stay within one vault (#328).
      const uses = USES(members.get(mid)).filter(([, key]) => !members.has(mine(key)) && !key.startsWith(`${toId}/`)).map(([u]) => u);
      if (uses.length) dropped.push({ id: mid, title: members.get(mid).title, uses });
    }
  }
  if (refused) {
    return { refused, members: [], blocked: [...list.map((m) => ({ id: m.id, title: m.title, reason: refused })), ...blocked], dropped: [], items: members, order };
  }
  return { refused: null, members: list, blocked, dropped, items: members, order };
}

/**
 * Removes a copy from the target for good: deleted, then purged (Key Vault: the purge only works once the deletion is
 * through, hence the retries; the file vault marks it purged). → "gone" | "trash" (deleted, purge not possible: purge
 * protection, missing right – it lies in the recycle bin) | "left" (could not even be deleted).
 */
async function removeCopy(session, toId, id, retryMs) {
  try {
    await session.deleteItem(toId, id);
  } catch {
    return 'left';
  }
  for (let i = 0; i < 5; i++) {
    try {
      await session.purge(toId, id);
      return 'gone';
    } catch (e) {
      if (e?.status !== 409 && e?.status !== 404) return 'trash';
      if (retryMs) await new Promise((r) => setTimeout(r, retryMs));
    }
  }
  return 'trash';
}

/**
 * Moves the entry with the assets of its plan: into another vault (`toId`) or, with the same vault, into `folder`.
 * Cross-vault: first everything is created in the target (links rewritten to the new keys); if one entry fails, what
 * was created is removed again and the source stays untouched. Only then the originals are deleted, users before what
 * they use. If a deletion fails, the copies in the target are complete and valid; the error names what is still left
 * in the source. → { saved, moved: [{ title, key }], dropped }.
 */
export async function moveWithAssets(session, fromId, toId, id, { folder, expected, purgeRetryMs = 1500 } = {}) {
  const plan = await planMoveWithAssets(session, fromId, toId, id);
  if (plan.refused) throw new Error(plan.refused);
  const { items, order } = plan;
  // The plan is calculated again here: what the dialog showed must be exactly what moves (entries may have changed since).
  if (expected && (expected.length !== order.length || !expected.every((e) => order.includes(e)))) {
    throw new Error(t('Die Verknüpfungen haben sich geändert, seit der Dialog sie gezeigt hat. Es wurde nichts verschoben. Bitte den Dialog neu öffnen und die Liste prüfen.'));
  }
  const title = (mid) => items.get(mid).title;
  const folderOf = (mid) => (folder ?? items.get(mid).folder);
  const moved = [];

  if (fromId === toId) {
    if (folder === undefined) throw new Error(t('Kein Zielordner angegeben'));
    const done = [];
    try {
      for (const mid of order) {
        const saved = await session.saveItem(fromId, { ...items.get(mid), folder: folderOf(mid) }, { expectedVersion: items.get(mid).version });
        done.push(mid);
        moved.push({ title: title(mid), key: saved.key, id: saved.id });
      }
    } catch (e) {
      const stuck = [];
      for (const mid of done.reverse()) await session.saveItem(fromId, items.get(mid)).catch(() => stuck.push(title(mid)));
      throw new MoveAssetsError(stuck.length
        ? t('Verschieben abgebrochen bei „{title}“ ({error}). Nicht zurückgesetzt und im neuen Ordner: {list}.', { title: title(order[done.length]), error: e.message, list: stuck.join(', ') })
        : t('Verschieben abgebrochen bei „{title}“ ({error}). Alle Einträge sind wieder im alten Ordner, nichts wurde geändert.', { title: title(order[done.length]), error: e.message }),
      { stage: 'copy', stuck });
    }
    return { saved: await session.getItem(fromId, id, { fresh: true }), moved, dropped: [] };
  }

  const newId = new Map();
  const created = [];
  // Links stay within one vault (#328): into a moved entry → its new key, into the target vault → unchanged, else removed.
  const rewrite = (key) => {
    if (!key || key.startsWith(`${toId}/`)) return key;
    return key.startsWith(`${fromId}/`) && newId.has(key.slice(fromId.length + 1)) ? `${toId}/${newId.get(key.slice(fromId.length + 1))}` : '';
  };
  let current = '';
  const planned = new Map(); // the id a copy gets is fixed beforehand: a write that timed out may still have happened
  try {
    for (const mid of order) {
      current = mid;
      const it = items.get(mid);
      planned.set(mid, newItemId());
      await session.requireLicenseForNew(await session.container(toId));
      const sv = it.server && {
        ...it.server, rdpLink: rewrite(it.server.rdpLink), tvLink: rewrite(it.server.tvLink),
        bastionLoginLink: rewrite(it.server.bastionLoginLink), bastionVmLink: rewrite(it.server.bastionVmLink),
      };
      const saved = await session.saveItem(toId, { ...it, id: planned.get(mid), folder: folderOf(mid), ...(sv ? { server: sv } : {}), ...(it.loginLink ? { loginLink: rewrite(it.loginLink) } : {}) }, { privacy: { owner: it.privateOwner, name: it.privateOwnerName } });
      newId.set(mid, saved.id);
      created.push(mid);
    }
  } catch (e) {
    // The write that failed may still have arrived (timeout): look in the target before saying that nothing is there.
    const unsure = [];
    if (current && !created.includes(current)) {
      const present = await session.getItem(toId, planned.get(current), { fresh: true }).then((x) => !!x, (err) => (err?.status === 404 || /nicht gefunden|not found/i.test(err?.message || '') ? false : null));
      if (present) {
        newId.set(current, planned.get(current));
        created.push(current);
      } else if (present === null) unsure.push(title(current));
    }
    const undone = [];
    for (const mid of created.reverse()) undone.push({ mid, state: await removeCopy(session, toId, newId.get(mid), purgeRetryMs) });
    const left = undone.filter((u) => u.state === 'left').map((u) => title(u.mid));
    const trash = undone.filter((u) => u.state === 'trash').map((u) => title(u.mid));
    const stuck = [...left, ...unsure];
    const head = t('Verschieben abgebrochen bei „{title}“ ({error}). ', { title: title(current), error: e.message });
    let text = head + t('Alle Einträge liegen unverändert im Quelltresor, im Zieltresor ist nichts übrig geblieben.');
    if (stuck.length || trash.length) {
      text = head + t('Im Quelltresor ist alles unverändert.');
      if (left.length) text += ' ' + t('Im Zieltresor sind noch Kopien: {list}. Bitte dort löschen.', { list: left.join(', ') });
      if (unsure.length) text += ' ' + t('Ob „{list}“ im Zieltresor angekommen ist, ließ sich nicht prüfen. Bitte dort nachsehen.', { list: unsure.join(', ') });
      if (trash.length) text += ' ' + t('Im Papierkorb des Zieltresors liegen noch Kopien (endgültiges Löschen war nicht möglich): {list}. Wer dort schreiben darf, kann sie samt Passwörtern und Passkeys wiederherstellen. Bitte dort endgültig löschen.', { list: trash.join(', ') });
    }
    throw new MoveAssetsError(text, { stage: 'copy', stuck, trash });
  }

  const left = [...order];
  try {
    for (const mid of [...order].reverse()) {
      await session.deleteItem(fromId, mid);
      left.splice(left.indexOf(mid), 1);
    }
  } catch (e) {
    throw new MoveAssetsError(t('Die Einträge liegen vollständig im Zieltresor, mit gültigen Verknüpfungen. Im Quelltresor konnte „{title}“ nicht gelöscht werden ({error}); dort liegen noch: {list}. Bitte dort löschen.', { title: title(left.at(-1)), error: e.message, list: left.map(title).join(', ') }),
      { stage: 'delete', left: left.map(title) });
  }
  for (const mid of order) moved.push({ title: title(mid), key: `${toId}/${newId.get(mid)}`, id: newId.get(mid) });
  return { saved: await session.getItem(toId, newId.get(id)), moved, dropped: plan.dropped };
}

/**
 * Moves a passkey to another login (saved in the wrong entry). Added to the target first, removed from the source
 * after that – if the second step fails the passkey is in both entries, never in none. Used by the app and the demo.
 */
export async function movePasskeyBetween(session, { from, to, credentialId }) {
  if (from.containerId === to.containerId && from.id === to.id) return false;
  const source = await session.getItem(from.containerId, from.id, { fresh: true });
  const passkey = source.passkeys.find((p) => p.credentialId === credentialId);
  if (!passkey) throw new Error(t('Der Passkey ist nicht mehr in diesem Eintrag'));
  const target = await session.getItem(to.containerId, to.id, { fresh: true });
  if (target.type !== 'login') throw new Error(t('Passkeys lassen sich nur in Login-Einträge verschieben'));
  if (!target.passkeys.some((p) => p.credentialId === credentialId)) {
    await session.saveItem(to.containerId, {
      ...target, passkeys: [...target.passkeys, passkey], username: target.username || passkey.userName || '',
    }, { expectedVersion: target.version });
  }
  await session.saveItem(from.containerId, { ...source, passkeys: source.passkeys.filter((p) => p.credentialId !== credentialId) }, { expectedVersion: source.version });
  return true;
}
