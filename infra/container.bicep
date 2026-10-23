// Keevault container: RBAC Key Vault tagged for discovery, role assignments for members and
// optional audit logs. Deploy per resource group:
//   az deployment group create -g rg-kvpwsafe -f infra/container.bicep -p name=kv-pws-ops displayName='Team Ops' members=@members.json

@description('Key Vault name (3–24 characters, globally unique)')
@minLength(3)
@maxLength(24)
param name string

@description('Name shown in the apps')
param displayName string = name

param location string = resourceGroup().location

@description('Purge protection: deleted items can only be removed permanently after the retention period. Cannot be disabled later.')
param purgeProtection bool = true

@description('Members: [{ principalId, principalType: User|Group|ServicePrincipal, level: read|write|manage }]')
param members array = []

@description('Optional Log Analytics workspace resource ID for Key Vault audit logs')
param logAnalyticsWorkspaceId string = ''

var roles = {
  secretsUser: '4633458b-17de-408a-b874-0445c86b69e6'
  secretsOfficer: 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
  dataAccessAdmin: '8b54135c-b56d-4d72-a534-26097cfdc8d8'
  reader: 'acdd72a7-3385-48ef-bd42-f606fba81ae7'
}
var levelRoles = {
  read: [roles.secretsUser, roles.reader]
  write: [roles.secretsOfficer, roles.reader]
  manage: [roles.secretsOfficer, roles.dataAccessAdmin, roles.reader]
}
var assignments = flatten(map(members, m => map(levelRoles[m.level], r => {
  principalId: m.principalId
  principalType: m.principalType
  role: r
})))

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: name
  location: location
  tags: {
    kvpwsafe: 'container'
    'kvpwsafe-name': displayName
  }
  properties: {
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
    principalType: a.principalType
  }
}]

resource audit 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  name: 'kvpwsafe-audit'
  scope: vault
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        categoryGroup: 'audit'
        enabled: true
      }
    ]
  }
}

output vaultUri string = vault.properties.vaultUri
output resourceId string = vault.id
