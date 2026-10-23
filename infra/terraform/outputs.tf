output "vault_uri" {
  description = "Adresse des Key Vaults (für „Tresor hinzufügen“ in Keevault, falls er nicht automatisch erscheint)"
  value       = azurerm_key_vault.this.vault_uri
}

output "resource_id" {
  value = azurerm_key_vault.this.id
}

output "role_assignments" {
  description = "Vergebene Rollen (Objekt-ID → Rolle)"
  value       = [for a in local.assignments : "${a.principal}: ${a.role}"]
}
