# Eigene Azure-Rollen für Keevault (Least Privilege)

Die eingebauten Rollen „Key Vault Secrets User“ (lesen) und „Key Vault Secrets Officer“ (bearbeiten) funktionieren,
der Officer darf aber mehr als Keevault braucht (u. a. endgültig löschen/Purge, Sichern/Wiederherstellen über die
Key-Vault-API). Diese zwei Rollen sind auf genau die Aktionen zugeschnitten, die Keevault nutzt:

| Rolle | Darf | Darf nicht |
| --- | --- | --- |
| **Keevault User** | Einträge auflisten, lesen, anlegen, ändern, löschen (Soft Delete), aus einem Keevault-Backup wiederherstellen | endgültig löschen (Purge), Schlüssel, Zertifikate, Rollen, Netzwerk- oder Tresor-Einstellungen |
| **Keevault Reader** | Einträge auflisten und lesen | alles andere |

Verwaltung (Rollen vergeben, Tresor-Einstellungen in Keevault) bleibt bei „Key Vault Administrator“ bzw. „Besitzer“ –
am besten nur per **PIM** zeitlich begrenzt.

## Anlegen

In beiden Dateien `AssignableScopes` auf die eigene Subscription (oder Ressourcengruppe) setzen, dann:

```powershell
az role definition create --role-definition keevault-user.json
az role definition create --role-definition keevault-reader.json
```

## Zuweisen (pro Tresor)

```powershell
$vault = az keyvault show --name <tresor> --query id -o tsv
az role assignment create --role "Keevault User"   --assignee <benutzer-oder-gruppe> --scope $vault
az role assignment create --role "Keevault Reader" --assignee <benutzer-oder-gruppe> --scope $vault
```

Hinweis: „Für mich freischalten“ und das Teilen in der App vergeben weiterhin die eingebauten Rollen. Wer die
eigenen Rollen nutzt, weist sie im Azure-Portal oder per Skript zu.

---

# Custom Azure roles for Keevault (least privilege)

Same content in short: **Keevault User** = list, read, create, change, delete (soft delete) and restore from a Keevault
backup; **Keevault Reader** = list and read. Neither may purge, manage keys, certificates, roles or vault settings.
Create them with `az role definition create --role-definition <file>.json` after setting `AssignableScopes`, assign
them per vault with `az role assignment create`. Sharing in the app still uses the built-in roles.
