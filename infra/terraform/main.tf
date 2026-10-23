# Keevault vault: RBAC Key Vault in the subscription's tenant, tagged for discovery, roles for users/guests/groups and
# the vault marker (secret pws-container), so the vault appears in Keevault right away for everyone with access.

data "azurerm_subscription" "current" {}
data "azurerm_client_config" "current" {}

locals {
  display_name = var.display_name != "" ? var.display_name : var.vault_name
  roles = {
    read   = ["Key Vault Secrets User", "Reader"]
    write  = ["Key Vault Secrets Officer", "Reader"]
    manage = ["Key Vault Secrets Officer", "Key Vault Data Access Administrator", "Reader"]
  }
  levels     = ["read", "write", "manage"]
  all_users  = distinct(flatten([for l in local.levels : var.access[l].users]))
  all_guests = distinct(flatten([for l in local.levels : var.access[l].guests]))
  all_groups = distinct(flatten([for l in local.levels : var.access[l].groups]))
}

data "azuread_user" "users" {
  for_each            = toset(local.all_users)
  user_principal_name = each.value
}

data "azuread_user" "guests" {
  for_each = toset(local.all_guests)
  mail     = each.value
}

data "azuread_group" "groups" {
  for_each         = toset(local.all_groups)
  display_name     = each.value
  security_enabled = true
}

locals {
  principals = {
    for l in local.levels : l => distinct(concat(
      [for u in var.access[l].users : data.azuread_user.users[u].object_id],
      [for g in var.access[l].guests : data.azuread_user.guests[g].object_id],
      [for g in var.access[l].groups : data.azuread_group.groups[g].object_id],
      var.access[l].object_ids,
      l == "manage" && var.grant_current_user ? [data.azurerm_client_config.current.object_id] : [],
    ))
  }
  # One assignment per principal and role, even if a principal is listed in several levels.
  assignments = distinct(flatten([
    for l in local.levels : [for p in local.principals[l] : [for r in local.roles[l] : { principal = p, role = r }]]
  ]))
}

resource "azurerm_resource_group" "this" {
  count    = var.create_resource_group ? 1 : 0
  name     = var.resource_group_name
  location = var.location
  tags     = var.tags
}

data "azurerm_resource_group" "this" {
  count = var.create_resource_group ? 0 : 1
  name  = var.resource_group_name
}

resource "azurerm_key_vault" "this" {
  name                = var.vault_name
  location            = var.location
  resource_group_name = var.create_resource_group ? azurerm_resource_group.this[0].name : data.azurerm_resource_group.this[0].name
  # Must be the subscription's tenant – a vault in another tenant (typical via Lighthouse) never honors its roles.
  tenant_id                     = data.azurerm_subscription.current.tenant_id
  sku_name                      = "standard"
  rbac_authorization_enabled    = true
  soft_delete_retention_days    = 90
  purge_protection_enabled      = var.purge_protection
  public_network_access_enabled = true

  network_acls {
    default_action = length(var.allowed_ip_ranges) > 0 ? "Deny" : "Allow"
    bypass         = "AzureServices"
    ip_rules       = var.allowed_ip_ranges
  }

  tags = merge(var.tags, {
    kvpwsafe        = "container"
    "kvpwsafe-name" = local.display_name
  })

  lifecycle {
    precondition {
      condition     = lower(var.tenant_id) == lower(data.azurerm_subscription.current.tenant_id)
      error_message = "tenant_id ist nicht der Tenant der Subscription. Mit einem Konto dieses Tenants anmelden (az login --tenant <Tenant der Subscription>), z. B. als Gast – nicht über Lighthouse."
    }
  }
}

resource "azurerm_role_assignment" "access" {
  for_each             = { for a in local.assignments : "${a.principal}/${a.role}" => a }
  scope                = azurerm_key_vault.this.id
  role_definition_name = each.value.role
  principal_id         = each.value.principal
}

resource "random_uuid" "container" {}

# Vault marker as Keevault writes it. Management plane (azapi): no data role and no wait for role propagation needed.
# Keevault later stores the license and the logo in it – never overwrite it from here.
resource "azapi_resource" "marker" {
  type      = "Microsoft.KeyVault/vaults/secrets@2023-07-01"
  name      = "pws-container"
  parent_id = azurerm_key_vault.this.id
  tags      = { kvpwsafe = "container" }
  body = {
    properties = {
      contentType = "application/vnd.kvpwsafe.container+json; v=1"
      value = jsonencode({
        format  = "kvpwsafe-container"
        v       = 1
        id      = random_uuid.container.result
        created = timestamp()
        updated = timestamp()
        name    = local.display_name
      })
    }
  }
  lifecycle {
    ignore_changes = [body, tags]
  }
}

resource "azurerm_monitor_diagnostic_setting" "audit" {
  count                      = var.log_analytics_workspace_id != "" ? 1 : 0
  name                       = "kvpwsafe-audit"
  target_resource_id         = azurerm_key_vault.this.id
  log_analytics_workspace_id = var.log_analytics_workspace_id
  enabled_log {
    category_group = "audit"
  }
}
