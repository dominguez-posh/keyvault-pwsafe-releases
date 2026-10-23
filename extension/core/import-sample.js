// Sample file for the generic CSV import (also stored as samples/kvpwsafe-import-sample.csv).
// Columns: title, username, password, url (several separated by spaces), totp, notes, folder, favorite (1/0),
// type (login/note). Any further column becomes an additional field of the entry.
export const SAMPLE_CSV = `title,username,password,url,totp,notes,folder,favorite,type,PIN
GitHub,alex@contoso.com,Ein-sicheres-Passwort-123,https://github.com/login,otpauth://totp/GitHub:alex?secret=JBSWY3DPEHPK3PXP&issuer=GitHub,"Notizen dürfen
mehrere Zeilen haben",Arbeit,1,login,
Microsoft 365,alex@contoso.com,Noch-ein-Passwort-456,https://login.microsoftonline.com https://www.office.com,,,Arbeit,0,login,
Bank,12345678,Bank-Passwort-789,https://banking.example.com,,,Privat,0,login,4711
WLAN Zuhause,,,,,"SSID: Contoso-Home
Passwort: siehe Router",Privat,0,note,
`;
