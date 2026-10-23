// Keevault vault for "Deploy to Azure" (one click in the Azure portal). Compiled to azuredeploy.json:
//   az bicep build -f infra/azuredeploy.bicep
// Creates an RBAC Key Vault in the subscription's tenant, tags it for discovery, grants roles and writes the vault
// marker (secret pws-container) through ARM – so the vault appears in Keevault right away for everyone with access.

@description('Name des Key Vaults: 3–24 Zeichen, Buchstaben, Ziffern, Bindestriche, weltweit eindeutig (z. B. kv-pws-teamops)')
@minLength(3)
@maxLength(24)
param vaultName string

@description('Anzeigename des Tresors in Keevault, z. B. „Team Ops“')
param displayName string = vaultName

@description('Region – leer lassen für die Region der Ressourcengruppe')
param location string = resourceGroup().location

@description('Lesen: Objekt-IDs von Benutzern oder Gruppen (Entra ID → Benutzer/Gruppen → Objekt-ID)')
param readPrincipalIds array = []

@description('Bearbeiten: Objekt-IDs von Benutzern oder Gruppen')
param writePrincipalIds array = []

@description('Verwalten (Bearbeiten + Freigeben): Objekt-IDs von Benutzern oder Gruppen')
param managePrincipalIds array = []

@description('Dir selbst (wer bereitstellt) die Stufe Verwalten geben')
param grantDeployer bool = true

@description('Löschschutz: gelöschte Einträge sind 90 Tage wiederherstellbar und erst danach endgültig weg. Nicht umkehrbar – empfohlen.')
param purgeProtection bool = true

@description('Tresor-Kennzeichnung schreiben. Beim ERNEUTEN Ausführen auf false setzen – sonst werden Lizenz und Logo des Tresors überschrieben.')
param writeMarker bool = true

@description('Nicht ändern (Kennung des Tresors)')
param containerId string = newGuid()

@description('Nicht ändern (Zeitstempel)')
param created string = utcNow('yyyy-MM-ddTHH:mm:ssZ')

var roles = {
  secretsUser: '4633458b-17de-408a-b874-0445c86b69e6'
  secretsOfficer: 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
  dataAccessAdmin: '8b54135c-b56d-4d72-a534-26097cfdc8d8'
  reader: 'acdd72a7-3385-48ef-bd42-f606fba81ae7'
}
// Reader on the vault lets the app find it (Resource Graph) and show the access level.
var levelRoles = {
  read: [roles.secretsUser, roles.reader]
  write: [roles.secretsOfficer, roles.reader]
  manage: [roles.secretsOfficer, roles.dataAccessAdmin, roles.reader]
}
var managers = union(managePrincipalIds, grantDeployer ? [deployer().objectId] : [])
// union() drops duplicates: a person in two levels (e.g. deployer also listed under write) gets each role once.
var assignments = union(flatten([
  flatten(map(readPrincipalIds, p => map(levelRoles.read, r => { principalId: p, role: r })))
  flatten(map(writePrincipalIds, p => map(levelRoles.write, r => { principalId: p, role: r })))
  flatten(map(managers, p => map(levelRoles.manage, r => { principalId: p, role: r })))
]), [])

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: vaultName
  location: location
  tags: {
    kvpwsafe: 'container'
    'kvpwsafe-name': displayName
  }
  properties: {
    // The subscription's tenant – never the tenant of whoever deploys (e.g. via Lighthouse), or the roles never apply.
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: purgeProtection ? true : null
    publicNetworkAccess: 'Enabled'
  }
}

resource roleAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for a in assignments: {
  name: guid(vault.id, a.principalId, a.role)
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', a.role)
    principalId: a.principalId
  }
}]

// Vault marker as Keevault writes it (management plane – needs no data role and no wait for role propagation).
resource marker 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (writeMarker) {
  parent: vault
  name: 'pws-container'
  tags: {
    kvpwsafe: 'container'
  }
  properties: {
    contentType: 'application/vnd.kvpwsafe.container+json; v=1'
    value: string({
      format: 'kvpwsafe-container'
      v: 1
      id: containerId
      created: created
      updated: created
      name: displayName
    })
  }
}

output vaultUri string = vault.properties.vaultUri
output resourceId string = vault.id
