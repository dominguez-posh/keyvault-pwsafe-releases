// Adding a Key Vault vault: the list of existing ones and the wizard that creates a new one.

import { h, icon, iconButton, setChildren, toast, modal } from '../../../extension/core/dom.js';
import { ACCESS_LEVELS } from '../../../extension/core/azure.js';
import { t, getLanguage } from '../../../extension/core/i18n.js';
import { call } from './ipc.js';
import { setSt, st, ui } from './state.js';
import { LEVEL_LABEL, field, notice, openUrl } from './helpers.js';
import { createFileDialog } from './file-vaults.js';
import { fetchState, reloadAll } from './shell.js';

export function addContainerDialog(prefill = '') {
  const input = h('input', { value: prefill, placeholder: t('https://<name>.vault.azure.net oder kvpwsafe://add?…') });
  const name = h('input', { placeholder: t('optional') });
  const list = h('div', { class: 'vault-list' });
  const filter = h('input', { type: 'search', placeholder: t('Key Vaults filtern (Name, Ressourcengruppe)'), hidden: true });
  let allVaults = [];
  const showVaults = () => {
    const q = filter.value.trim().toLowerCase();
    const vaults = q ? allVaults.filter((v) => [v.name, v.vaultUrl, v.resourceGroup].some((x) => String(x || '').toLowerCase().includes(q))) : allVaults;
    setChildren(list, vaults.length
      ? vaults.slice(0, 200).map((v) => h('button', { type: 'button', class: 'option-card', disabled: v.added, onclick: () => {
        input.value = v.vaultUrl;
        name.value = v.name;
      } }, icon('vault', 18), h('div', {}, h('b', {}, v.name),
        h('div', { class: 'muted small' }, [v.resourceGroup, v.added ? t('bereits hinzugefügt') : v.access ? t(LEVEL_LABEL[v.access.write ? (v.access.manage ? 'manage' : 'write') : 'read']) : v.container ? t('Keevault-Tresor') : null].filter(Boolean).join(' · ')))))
      : [h('p', { class: 'muted small' }, q ? t('Keine Treffer') : showAll.checked
        ? t('Keine Key Vaults sichtbar. Für die Liste brauchst du mindestens die Rolle „Leser“ auf dem Key Vault.')
        : t('Keine eingerichteten Passwort-Tresore mit Zugriff gefunden. Für die Liste brauchst du „Leser“ und eine Key-Vault-Datenrolle.'))]);
  };
  filter.addEventListener('input', showVaults);
  const showAll = h('input', { type: 'checkbox' });
  const loadVaults = () => {
    list.replaceChildren(h('span', { class: 'spinner' }));
    call('vaults', { all: showAll.checked }).then((vaults) => {
      allVaults = vaults;
      filter.hidden = vaults.length < 6;
      showVaults();
      if (!filter.hidden) filter.focus();
    }, (e) => setChildren(list, [h('p', { class: 'muted small' }, e.message)]));
  };
  showAll.addEventListener('change', loadVaults);
  const showAllLabel = h('label', { class: 'inline small muted' }, showAll, t('Auch Key Vaults zeigen, die nicht als Passwort-Tresore eingerichtet sind'));
  if (st.signedIn && !prefill) loadVaults();
  else showAllLabel.hidden = true;
  modal(t('Tresor hinzufügen'), h('div', {},
    h('p', { class: 'muted' }, t('Füge einen vorhandenen Key Vault hinzu, z. B. aus einer Einladung. Ohne passende Azure-Rolle bleibt er gesperrt.')),
    filter,
    list,
    showAllLabel,
    field(t('Key Vault oder Einladungslink'), input),
    field(t('Anzeigename'), name)), [
    { label: t('Abbrechen') },
    { label: t('Hinzufügen'), primary: true, onClick: async () => {
      const id = await call('addContainer', input.value, name.value.trim());
      toast(t('Tresor hinzugefügt'));
      if (st?.opened) {
        ui.containerId = id;
        ui.view = 'container';
        await reloadAll();
      }
    } },
  ]);
}

function suggestVaultName(text) {
  const slug = String(text).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `kv-pws-${slug}`.slice(0, 24).replace(/-+$/, '');
}

/**
 * Setup wizard for a team vault in Azure Key Vault, step by step with what each step means: what it is and what is
 * needed → sign in → where (subscription, resource group, new or existing empty Key Vault) → who gets access →
 * break-glass accounts → check and create. intro: false starts at the sign-in (or, signed in, at "where").
 */
export async function vaultWizard({ intro = true } = {}) {
  const s = { step: intro ? 0 : st.signedIn ? 2 : 1, subs: null, done: null };
  const body = h('div', { class: 'wizard vault-wizard' });
  const { dialog, close } = modal(t('Tresor einrichten'), body, []);
  dialog.classList.add('wizard-modal');
  const steps = [t('Start'), t('Anmelden'), t('Ort'), t('Zugriff'), t('Notfallzugang'), t('Erstellen')];
  const header = () => h('ol', { class: 'wizard-steps' }, ...steps.map((label, i) => h('li', { class: i === s.step ? 'on' : i < s.step ? 'done' : '' }, h('span', {}, String(i + 1)), label)));
  const buttons = (...b) => h('div', { class: 'wizard-buttons' }, ...b);
  const btn = (label, onClick, { primary = false, disabled = false } = {}) => h('button', { type: 'button', class: primary ? 'btn primary' : 'btn', disabled, onclick: async (e) => {
    const el = e.currentTarget;
    el.disabled = true;
    try { await onClick(); } catch (err) { toast(err.message, 'error'); } finally { el.disabled = false; }
  } }, label);
  const go = async (step) => {
    s.step = step;
    if (step === 2 && !s.subs) await loadSubscriptions();
    draw();
  };
  const explain = (...lines) => h('div', { class: 'wizard-explain' }, ...lines.map((x) => (typeof x === 'string' ? h('p', {}, x) : x)));

  const VIA = { home: '', guest: t('Gast'), lighthouse: t('nur Lighthouse') };
  const display = h('input', { placeholder: t('z. B. Team Infrastruktur') });
  const name = h('input', { placeholder: t('kv-pws-team (weltweit eindeutig)') });
  const sub = h('select');
  const rg = h('select');
  const loc = h('select');
  const purge = h('input', { type: 'checkbox', checked: true });
  const subNotice = h('div');
  const rgNotice = h('div');
  // Mode: create a new vault in the resource group, or use an existing empty one there.
  const mode = h('select', {},
    h('option', { value: 'new' }, t('Neuen Key Vault in der Ressourcengruppe anlegen')),
    h('option', { value: 'existing' }, t('Vorhandenen leeren Key Vault verwenden')));
  const existing = h('select');
  let rgPermissions = null;
  const newFields = h('div', {}, field(t('Key-Vault-Name'), name, t('3–24 Zeichen: Buchstaben, Ziffern, Bindestriche')));
  const existingFields = h('div', { hidden: true }, field(t('Key Vault'), existing));
  const current = () => (s.subs || []).find((x) => x.id === sub.value);
  const drawRgNotice = () => {
    const x = current();
    const msg = !x || x.via === 'lighthouse' ? null
      : mode.value === 'new' && rgPermissions && !rgPermissions.createVault
        ? notice(t('Auf dieser Ressourcengruppe darfst du keine Key Vaults anlegen (nötig: Besitzer oder Mitwirkender). Wähle „Vorhandenen leeren Key Vault verwenden“ oder eine andere Ressourcengruppe.'), 'warn')
        : rgPermissions && !rgPermissions.assignRoles
          ? notice(t('Du darfst hier keine Rollen vergeben – Zugriff für Gruppen und Gäste muss dann jemand mit Besitzer-Rechten erteilen.'), 'info') : null;
    setChildren(rgNotice, msg);
  };
  const loadGroup = async () => {
    const x = current();
    rgPermissions = null;
    existing.replaceChildren();
    if (!x || !rg.value || x.via === 'lighthouse') return drawRgNotice();
    call('groupPermissions', x.id, x.tenantId, rg.value).then((p) => { rgPermissions = p; drawRgNotice(); }, () => drawRgNotice());
    if (mode.value !== 'existing') return drawRgNotice();
    existing.replaceChildren(h('option', { value: '' }, t('Wird geladen …')));
    try {
      const vaults = await call('groupVaults', x.id, x.tenantId, rg.value);
      const label = (v) => (v.added ? t('bereits in der App') : v.marked ? t('bereits Tresor') : !v.readable ? t('kein Datenzugriff') : !v.empty ? t('nicht leer') : '');
      existing.replaceChildren(...(vaults.length ? vaults.map((v) => h('option', {
        value: v.vaultUrl, disabled: !v.readable || (!v.empty && !v.marked) || v.added, dataset: { resourceId: v.resourceId, name: v.name },
      }, label(v) ? `${v.vaultName} (${label(v)})` : v.vaultName)) : [h('option', { value: '' }, t('Keine Key Vaults in dieser Ressourcengruppe'))]));
      const firstUsable = [...existing.options].find((o) => !o.disabled && o.value);
      if (firstUsable) existing.value = firstUsable.value;
    } catch (e) {
      existing.replaceChildren(h('option', { value: '' }, e.message));
    }
    return drawRgNotice();
  };
  const regionField = field(t('Region'), loc);
  const purgeLabel = h('label', { class: 'inline' }, purge, t('Löschschutz (Purge Protection) – empfohlen, nicht umkehrbar'));
  mode.addEventListener('change', () => {
    newFields.hidden = mode.value !== 'new';
    existingFields.hidden = mode.value !== 'existing';
    purgeLabel.hidden = mode.value !== 'new';
    regionField.hidden = mode.value !== 'new';
    loadGroup();
  });

  // Access: Entra groups / people of the subscription's tenant and guests to invite.
  const access = []; // { principal } | { email }  + level
  const accessList = h('div', { class: 'access-list' });
  const search = h('input', { placeholder: t('Entra-Gruppe, Person oder E-Mail für einen Gast …') });
  const results = h('div', { class: 'search-results' });
  const level = h('select', {}, ...Object.entries(ACCESS_LEVELS).map(([k, v]) => h('option', { value: k, selected: k === 'read' }, t(v.label))));
  const drawAccess = () => setChildren(accessList, access.length
    ? access.map((a, i) => h('div', { class: 'member' },
      icon(a.email ? 'plus' : a.principal.type === 'Group' ? 'users' : 'user'),
      h('div', { class: 'row-text' }, h('div', { class: 'row-title' }, a.email || a.principal.displayName),
        h('div', { class: 'row-sub' }, a.email ? t('wird als Gast eingeladen') : a.principal.detail || '')),
      h('span', { class: 'badge accent' }, t(ACCESS_LEVELS[a.level].label)),
      iconButton('x', t('Entfernen'), () => { access.splice(i, 1); drawAccess(); })))
    : [h('p', { class: 'muted small' }, t('Noch niemand – du selbst bekommst immer Bearbeiten und Verwalten.'))]);
  const add = (entry) => {
    access.push({ ...entry, level: level.value });
    search.value = '';
    results.replaceChildren();
    drawAccess();
  };
  let timer;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = search.value.trim();
      if (q.length < 2) return results.replaceChildren();
      const found = await call('searchPrincipalsIn', q, current().tenantId).catch((e) => {
        toast(e.message, 'error');
        return [];
      });
      const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q) ? q.toLowerCase() : null;
      const choices = found.map((p) => h('button', { type: 'button', class: 'choice', onclick: () => add({ principal: p }) },
        icon(p.type === 'Group' ? 'users' : 'user'), h('span', {}, p.displayName), h('span', { class: 'muted small' }, p.type === 'Group' ? t('Gruppe') : p.detail)));
      if (email && !found.some((p) => String(p.detail || '').toLowerCase() === email)) {
        choices.push(current().via === 'lighthouse'
          ? h('div', { class: 'muted small' }, t('Gäste lassen sich nicht über Azure Lighthouse einladen.'))
          : h('button', { type: 'button', class: 'choice', onclick: () => add({ email }) }, icon('plus'), h('span', {}, t('„{email}“ als Gast einladen', { email }))));
      }
      return results.replaceChildren(...choices);
    }, 300);
  });
  drawAccess();

  // Break-glass accounts: permanent full access ("Manage") to the new vault, remembered per tenant for the next one.
  const breakGlass = [];
  const bgList = h('div', { class: 'access-list' });
  const bgSearch = h('input', { placeholder: t('Notfallkonto suchen (Name oder E-Mail) …') });
  const bgResults = h('div', { class: 'search-results' });
  const bgRemember = h('input', { type: 'checkbox', checked: true });
  const drawBreakGlass = () => setChildren(bgList, breakGlass.length
    ? breakGlass.map((p, i) => h('div', { class: 'member' }, icon(p.type === 'Group' ? 'users' : 'user'),
      h('div', { class: 'row-text' }, h('div', { class: 'row-title' }, p.displayName), h('div', { class: 'row-sub' }, p.detail || '')),
      h('span', { class: 'badge accent' }, t('Verwalten')),
      iconButton('x', t('Entfernen'), () => { breakGlass.splice(i, 1); drawBreakGlass(); })))
    : [notice(h('span', {}, t('Ohne Notfallkonto kommt niemand an die Passwörter, wenn die normale Anmeldung klemmt (Conditional Access, MFA, PIM). '),
      h('button', { type: 'button', class: 'linklike', onclick: () => openUrl(getLanguage() === 'en' ? 'https://keevault.de/en/knowledge/vault-hardening.html#break-glass-accounts' : 'https://keevault.de/wissen/tresor-absichern.html#break-glass-konten') }, t('Mehr zu Break-Glass-Konten'))), 'warn')]);
  let bgTimer;
  bgSearch.addEventListener('input', () => {
    clearTimeout(bgTimer);
    bgTimer = setTimeout(async () => {
      const q = bgSearch.value.trim();
      if (q.length < 2) return bgResults.replaceChildren();
      const found = await call('searchPrincipalsIn', q, current().tenantId).catch(() => []);
      return bgResults.replaceChildren(...found.filter((p) => !breakGlass.some((b) => b.id === p.id)).map((p) => h('button', { type: 'button', class: 'choice', onclick: () => {
        breakGlass.push({ id: p.id, type: p.type, displayName: p.displayName, detail: p.detail || '' });
        bgSearch.value = '';
        bgResults.replaceChildren();
        drawBreakGlass();
      } }, icon(p.type === 'Group' ? 'users' : 'user'), h('span', {}, p.displayName), h('span', { class: 'muted small' }, p.type === 'Group' ? t('Gruppe') : p.detail))));
    }, 300);
  });
  const loadBreakGlass = () => {
    breakGlass.length = 0;
    breakGlass.push(...((st.settings.breakGlass || {})[current()?.tenantId] || []));
    drawBreakGlass();
  };

  const syncLocation = () => {
    const l = rg.selectedOptions[0]?.dataset.location;
    if (l) loc.value = l;
  };
  const loadSubscription = async () => {
    const x = current();
    if (!x) return;
    setChildren(subNotice, x.via === 'lighthouse'
      ? notice(t('Diese Subscription siehst du nur über Azure Lighthouse. So angelegte Key Vaults lassen sich nicht nutzen: Lighthouse vergibt keine Datenrollen und lädt keine Gäste ein. Lass dich im Kunden-Tenant als Gast einladen und gib dem Gastkonto Besitzer auf der Ressourcengruppe – dann erscheint die Subscription hier mit „Gast“.'), 'warn')
      : x.via === 'guest' ? notice(t('Wird im Tenant „{tenant}“ mit deinem Gastkonto angelegt; Gruppen und Personen stammen aus diesem Verzeichnis.', { tenant: x.tenantName || x.tenantId }), 'info') : null);
    access.length = 0;
    drawAccess();
    loadBreakGlass();
    try {
      const [groups, locations] = await Promise.all([call('resourceGroups', x.id, x.tenantId), call('locations', x.id, x.tenantId)]);
      rg.replaceChildren(...groups.map((g) => h('option', { value: g.name, dataset: { location: g.location } }, g.name)));
      loc.replaceChildren(...locations.map((l) => h('option', { value: l.name }, l.displayName)));
      syncLocation();
      loadGroup();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  const loadSubscriptions = async () => {
    try {
      s.subs = await call('subscriptions');
    } catch (e) {
      s.subs = null;
      throw e;
    }
    sub.replaceChildren(...s.subs.map((x) => h('option', { value: x.id }, VIA[x.via] ? `${x.name} (${VIA[x.via]})` : x.name)));
    if (s.subs.length) await loadSubscription();
  };
  rg.addEventListener('change', () => {
    syncLocation();
    loadGroup();
  });
  sub.addEventListener('change', loadSubscription);
  display.addEventListener('input', () => {
    if (!name.dataset.touched) name.value = suggestVaultName(display.value);
  });
  name.addEventListener('input', () => {
    name.dataset.touched = '1';
  });

  const checkWhere = () => {
    const x = current();
    if (!x) throw new Error(t('Kein Azure-Abonnement verfügbar'));
    if (x.via === 'lighthouse') throw new Error(t('Über Azure Lighthouse lässt sich hier kein nutzbarer Tresor anlegen (siehe Hinweis).'));
    if (!rg.value) throw new Error(t('Bitte eine Ressourcengruppe wählen'));
    if (mode.value === 'existing') {
      const option = existing.selectedOptions[0];
      if (!option?.value || option.disabled) throw new Error(t('Bitte einen leeren Key Vault wählen'));
    } else {
      if (rgPermissions && !rgPermissions.createVault) throw new Error(t('Auf dieser Ressourcengruppe darfst du keine Key Vaults anlegen'));
      if (!/^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$/.test(name.value.trim())) throw new Error(t('Key-Vault-Name: 3–24 Zeichen, mit einem Buchstaben beginnen, Buchstaben, Ziffern und Bindestriche'));
    }
  };

  const create = async () => {
    const x = current();
    checkWhere();
    // Break-glass accounts get "Manage"; someone chosen in both lists keeps the higher level.
    const members = access.filter((a) => a.principal && !breakGlass.some((b) => b.id === a.principal.id)).map((a) => ({ principal: a.principal, level: a.level }))
      .concat(breakGlass.map((p) => ({ principal: p, level: 'manage' })));
    if (bgRemember.checked && x.tenantId) {
      const settings = await call('updateSettings', { breakGlass: { ...(st.settings.breakGlass || {}), [x.tenantId]: breakGlass.map((p) => ({ ...p })) } });
      st.settings = settings; // #535: assigned after the wait (a reload may replace st)
    }
    const guests = access.filter((a) => a.email).map((a) => ({ email: a.email, level: a.level }));
    let r;
    if (mode.value === 'existing') {
      const option = existing.selectedOptions[0];
      r = await call('adoptVault', {
        subscriptionId: x.id, tenantId: x.tenantId, via: x.via, vaultUrl: option.value, resourceId: option.dataset.resourceId,
        displayName: display.value.trim() || option.dataset.name, members, guests,
      });
    } else {
      toast(t('Tresor wird erstellt …'));
      r = await call('createContainer', {
        subscriptionId: x.id, tenantId: x.tenantId, via: x.via, resourceGroup: rg.value, location: loc.value,
        name: name.value.trim(), displayName: display.value.trim() || name.value.trim(), purgeProtection: purge.checked,
        members,
        guests,
      });
    }
    for (const w of r.warnings) toast(w, 'error');
    s.done = { id: r.id, warnings: r.warnings };
    ui.containerId = r.id;
    ui.view = 'container';
    await reloadAll();
    draw();
  };

  const choice = (iconName, title, text, onClick) => h('button', { type: 'button', class: 'option-card', onclick: onClick },
    icon(iconName, 20), h('div', {}, h('b', {}, title), h('div', { class: 'muted small' }, text)));

  const draw = () => {
    let content;
    if (s.done) {
      content = [
        explain(t('Der Tresor ist eingerichtet und steht in der Seitenleiste.'),
          t('Neue Rollen können einige Minuten brauchen, bis sie wirken – bis dahin kann der Tresor kurz „Kein Zugriff“ zeigen.'),
          t('Weitere Personen gibst du später per Rechtsklick auf den Tresor → „Teilen“ frei.')),
        s.done.warnings.length ? notice(t('Nicht alles hat geklappt – siehe Meldungen. Fehlende Rollen kann jemand mit Besitzer-Rechten nachtragen.'), 'warn') : null,
        buttons(btn(t('Fertig'), () => close(), { primary: true })),
      ];
    } else if (s.step === 0) {
      content = [
        explain(t('Ein Tresor ist der Ort, an dem Keevault Passwörter, Passkeys und Zertifikate speichert. Für ein Team oder eine Firma empfehlen wir einen Tresor in Azure Key Vault: Zugriff über Azure-Rollen, Audit-Log, keine Datei, die man kopieren kann.'),
          t('Wähle, was du einrichten möchtest. Der Assistent erklärt jeden Schritt.')),
        choice('plus', t('Neuen Tresor in Azure anlegen'), t('Für ein Team: Key Vault in deinem Azure-Abonnement, Zugriff für Gruppen und Personen. Nötig: Besitzer-Rechte auf einer Ressourcengruppe.'), () => go(1)),
        choice('link', t('Vorhandenen Tresor verbinden'), t('Ein Kollege hat schon einen Tresor eingerichtet und dir Zugriff gegeben, oder du hast einen Einladungslink.'), async () => {
          // Signed in, the dialog lists the vaults found in Azure to pick from.
          if (!st.signedIn) {
            try {
              await call('signIn');
              setSt(await fetchState());
            } catch (e) {
              toast(e.message, 'error');
            }
          }
          close();
          addContainerDialog();
        }),
        choice('note', t('Datei-Tresor (ohne Azure)'), t('Verschlüsselte Datei wie bei KeePass, z. B. auf einem Netzlaufwerk.'), () => { close(); createFileDialog(); }),
        buttons(btn(t('Später'), () => close())),
      ];
    } else if (s.step === 1) {
      content = [
        explain(t('Für einen Tresor in Azure meldest du dich mit deinem Arbeitskonto bei Microsoft an. Keevault fragt dabei nur nach den Rechten, die es für Key Vault braucht.'),
          t('Danach sucht Keevault deine Azure-Abonnements und Ressourcengruppen.')),
        st.signedIn ? notice(t('Angemeldet als {user}', { user: st.account?.username || '' }), 'info') : null,
        buttons(
          intro ? btn(t('Zurück'), () => go(0)) : null,
          st.signedIn
            ? btn(t('Weiter'), () => go(2), { primary: true })
            : btn(t('Mit Microsoft anmelden'), async () => {
              const r = await call('signIn');
              if (r.discoverError) toast(t('Tresor-Suche: {message}', { message: r.discoverError }), 'error');
              setSt(await fetchState());
              await go(2);
            }, { primary: true })),
      ];
    } else if (s.step === 2) {
      content = s.subs && !s.subs.length ? [
        explain(t('Mit diesem Konto ist kein Azure-Abonnement sichtbar. Für einen Tresor in Azure brauchst du ein Abonnement mit einer Ressourcengruppe, auf der du Besitzer bist – frag deine IT danach.'),
          t('Alternativ: Lass dir Zugriff auf einen vorhandenen Tresor geben oder richte einen Datei-Tresor ein.')),
        buttons(btn(t('Zurück'), () => go(1)), btn(t('Vorhandenen Tresor verbinden'), () => { close(); addContainerDialog(); })),
      ] : [
        explain(t('Der Tresor ist ein Azure Key Vault in einer Ressourcengruppe deines Abonnements. Keevault legt ihn mit RBAC und Soft Delete an und gibt dir Bearbeiten- und Verwalten-Rechte.'),
          t('Nötig: Besitzer (oder Mitwirkender + Benutzerzugriffsadministrator) auf der Ressourcengruppe. Der Anzeigename ist nur für die App, der Key-Vault-Name muss weltweit eindeutig sein.')),
        // Two columns: where (subscription, group), what (new or existing, region), names – fits without scrolling.
        h('div', { class: 'grid2' }, field(t('Abonnement'), sub), field(t('Ressourcengruppe'), rg)),
        subNotice,
        h('div', { class: 'grid2' }, field(t('Key Vault'), mode), regionField),
        rgNotice,
        h('div', { class: 'grid2' }, field(t('Anzeigename'), display), h('div', {}, newFields, existingFields)),
        purgeLabel,
        buttons(btn(t('Zurück'), () => go(1)), btn(t('Weiter'), () => { checkWhere(); return go(3); }, { primary: true })),
      ];
    } else if (s.step === 3) {
      content = [
        explain(t('Wer soll den Tresor nutzen? Am besten eine Entra-Gruppe (z. B. dein Team) statt einzelner Personen – dann regelt die Gruppenmitgliedschaft den Zugriff. Externe lädst du per E-Mail als Gast ein.'),
          t('Lesen: Passwörter ansehen und nutzen. Bearbeiten: auch anlegen und ändern. Verwalten: auch Zugriff vergeben. Du kannst das später jederzeit unter „Teilen“ ändern.')),
        h('div', { class: 'field-row access-search' }, search, level),
        results,
        accessList,
        buttons(btn(t('Zurück'), () => go(2)), btn(t('Weiter'), () => go(4), { primary: true })),
      ];
    } else if (s.step === 4) {
      content = [
        explain(t('Notfallkonten (Break-Glass-Konten) bekommen dauerhaft „Verwalten“ – ohne PIM und ohne Bedingungen. So kommt im Notfall jemand an die Passwörter, wenn die normale Anmeldung klemmt.'),
          t('Optional, aber empfohlen. Die Konten merkt sich Keevault für weitere Tresore in diesem Tenant.')),
        bgSearch,
        bgResults,
        bgList,
        h('label', { class: 'inline' }, bgRemember, t('Für neue Tresore in diesem Tenant merken')),
        buttons(btn(t('Zurück'), () => go(3)), btn(t('Weiter'), () => go(5), { primary: true })),
      ];
    } else {
      const x = current();
      const row = (label, value) => h('div', { class: 'summary-row' }, h('span', { class: 'muted' }, label), h('b', {}, value));
      content = [
        explain(t('Bitte prüfen. „Erstellen“ legt den Tresor in Azure an und vergibt die Rollen – das dauert etwa eine Minute.')),
        h('div', { class: 'wizard-summary' },
          row(t('Anzeigename'), display.value.trim() || (mode.value === 'existing' ? existing.selectedOptions[0]?.dataset.name || '' : name.value.trim())),
          row(t('Abonnement'), x?.name || ''),
          row(t('Ressourcengruppe'), rg.value),
          mode.value === 'existing'
            ? row(t('Key Vault'), existing.selectedOptions[0]?.textContent || '')
            : row(t('Key Vault'), `${name.value.trim()} · ${loc.selectedOptions[0]?.textContent || loc.value}${purge.checked ? ` · ${t('Löschschutz')}` : ''}`),
          row(t('Zugriff'), access.length ? access.map((a) => `${a.email || a.principal.displayName} (${t(ACCESS_LEVELS[a.level].label)})`).join(', ') : t('nur du')),
          row(t('Notfallkonten'), breakGlass.length ? breakGlass.map((p) => p.displayName).join(', ') : t('keine'))),
        buttons(btn(t('Zurück'), () => go(4)), btn(mode.value === 'existing' ? t('Einrichten') : t('Erstellen'), create, { primary: true })),
      ];
    }
    body.replaceChildren(header(), ...[content].flat().filter(Boolean));
  };
  if (s.step === 2) {
    body.replaceChildren(h('span', { class: 'spinner' }));
    try {
      await loadSubscriptions();
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  draw();
  return new Promise((resolve) => dialog.addEventListener('close', resolve));
}
