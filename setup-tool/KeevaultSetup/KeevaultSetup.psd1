@{
    RootModule        = 'KeevaultSetup.psm1'
    ModuleVersion     = '0.1.0'
    GUID              = '6f0f3c1e-5b8e-4d61-9a3f-2c7d1f0b5a01'
    Author            = 'Keevault'
    CompanyName       = 'Keevault'
    Copyright         = 'Elastic License 2.0'
    Description       = 'Keevault-Einrichtungstool (#501): richtet Azure Key Vault, Entra-Gruppen und Rollen für Keevault ein. Plan, Probelauf, Ausführen, Doku.'
    PowerShellVersion = '5.1'
    # Az.Accounts is loaded only when signing in (Connect-KeevaultSetup), so the module, its tests and the dry-run
    # stub work without it.
    FunctionsToExport = @(
        'Connect-KeevaultSetup'
        'Set-KeevaultSetupTransport'
        'Get-KeevaultSetupContext'
        'Get-KeevaultSetupRights'
        'New-KeevaultSetupPlan'
        'Test-KeevaultSetupPlan'
        'Import-KeevaultSetupPlan'
        'Export-KeevaultSetupPlan'
        'ConvertTo-KeevaultSetupPlanJson'
        'Get-KeevaultSetupPlanHash'
        'Get-KeevaultSetupStep'
        'Invoke-KeevaultSetup'
        'New-KeevaultSetupReport'
        'Set-KeevaultSetupLanguage'
        'ConvertTo-KeevaultSetupTerraform'
        'Export-KeevaultSetupDevicePolicy'
        'Publish-KeevaultSetupIntuneProfile'
        'Test-KeevaultSetupDrift'
        'Test-KeevaultSetupCompliance'
        'New-KeevaultSetupCheckReport'
        'Get-KeevaultSetupVersion'
        'Get-KeevaultSetupUpdate'
        'Install-KeevaultSetupUpdate'
        'Start-KeevaultSetupUi'
    )
    CmdletsToExport   = @()
    VariablesToExport = @()
    AliasesToExport   = @()
}
