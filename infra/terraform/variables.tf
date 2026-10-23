variable "subscription_id" {
  description = "Subscription, in der der Key Vault liegt"
  type        = string
}

variable "tenant_id" {
  description = "Tenant (Verzeichnis) DIESER Subscription – nicht der eigene Heim-Tenant bei Gast- oder Lighthouse-Zugriff"
  type        = string
}

variable "resource_group_name" {
  description = "Ressourcengruppe des Key Vaults"
  type        = string
}

variable "create_resource_group" {
  description = "Ressourcengruppe neu anlegen (true) oder eine vorhandene nutzen (false)"
  type        = bool
  default     = false
}

variable "location" {
  description = "Region, z. B. germanywestcentral"
  type        = string
  default     = "germanywestcentral"
}

variable "vault_name" {
  description = "Name des Key Vaults: 3–24 Zeichen, Buchstaben, Ziffern, Bindestriche, weltweit eindeutig"
  type        = string
  validation {
    condition     = can(regex("^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$", var.vault_name)) && !strcontains(var.vault_name, "--")
    error_message = "3–24 Zeichen, beginnt mit einem Buchstaben, Buchstaben/Ziffern/Bindestriche, keine doppelten Bindestriche."
  }
}

variable "display_name" {
  description = "Anzeigename des Tresors in Keevault, z. B. \"Team Ops\" (leer = vault_name)"
  type        = string
  default     = ""
}

variable "access" {
  description = <<-EOT
    Wer was darf – je Stufe:
      users      = Benutzer per UPN (anmeldename@firma.de)
      guests     = Gastbenutzer per E-Mail-Adresse
      groups     = Entra-ID-Sicherheitsgruppen per Anzeigename
      object_ids = weitere Objekt-IDs (z. B. Dienstprinzipale)
    read = Lesen, write = Bearbeiten, manage = Bearbeiten + Freigeben
  EOT
  type = object({
    read   = optional(object({ users = optional(list(string), []), guests = optional(list(string), []), groups = optional(list(string), []), object_ids = optional(list(string), []) }), {})
    write  = optional(object({ users = optional(list(string), []), guests = optional(list(string), []), groups = optional(list(string), []), object_ids = optional(list(string), []) }), {})
    manage = optional(object({ users = optional(list(string), []), guests = optional(list(string), []), groups = optional(list(string), []), object_ids = optional(list(string), []) }), {})
  })
  default = {}
}

variable "grant_current_user" {
  description = "Wer Terraform ausführt, bekommt die Stufe Verwalten"
  type        = bool
  default     = true
}

variable "purge_protection" {
  description = "Löschschutz (empfohlen, nicht umkehrbar)"
  type        = bool
  default     = true
}

variable "allowed_ip_ranges" {
  description = "Optional: nur diese öffentlichen IP-Bereiche dürfen zugreifen (CIDR). Leer = öffentlich erreichbar, geschützt durch Entra ID + Rollen."
  type        = list(string)
  default     = []
}

variable "log_analytics_workspace_id" {
  description = "Optional: Log-Analytics-Arbeitsbereich für das Zugriffsprotokoll (Ressourcen-ID)"
  type        = string
  default     = ""
}

variable "tags" {
  description = "Zusätzliche Tags für Ressourcengruppe und Key Vault"
  type        = map(string)
  default     = {}
}
