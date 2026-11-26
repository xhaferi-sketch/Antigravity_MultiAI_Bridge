# UDHËZUESI TEKNIK I PLANIFIKIMIT ARKITEKTUROR

Analizo paketën e bashkëngjitur të projektit dhe kërkesën teknike për të përgatitur planin e zbatimit (pa shkruar kod burimor në këtë fazë).
(Nëse kodi është i përfshirë si `project_bundle.txt`, analizo direkt skedarët në mesazh. Nëse është bashkëngjitur si `.zip.md`, trajtoje si arkiv `.zip`).

## 1. PARIMET E ANALIZËS TEKNIKE
- Bazohu në kodin real: ndaj qartë faktet e verifikuara në kod (`VERIFIED_FACT`) nga supozimet e deklaruara (`EXPLICIT_ASSUMPTION`).
- Identifiko **Entry Point-in real**, ndiq rrjedhën **End-to-End** (`caller -> handler -> side effect -> state/storage`) dhe izolo **Root Cause**.
- **Kufizimi i Fushëveprimit:** Mos shto funksionalitete të pakërkuara, mos bëj refactor jashtë objektit, mos ndrysho lockfiles/dependencies pa nevojë teknike dhe ruaj kontratat ekzistuese API.

## 2. STRUKTURA E PLANIT (`plan.md`)
Përgjigjja duhet të jetë koncize, teknike dhe të përmbajë këto seksione:
1. **OBJEKTIVI & NON-GOALS:** Çfarë zgjidhet saktësisht dhe çfarë NUK duhet prekur.
2. **ENTRY POINT & ROOT CAUSE:** Rruga e skedarëve, funksionet konkrete dhe shkaku i vërtetë teknik.
3. **ALLOWED_FILES & FORBIDDEN_FILES:** Shëno çdo skedar të autorizuar në rresht më vete me prefiksin `FILE_TARGET: rruga/relative/skedari.ext` dhe listo veçmas skedarët që nuk duhen prekur.
4. **SPECIFIKIMI SKEDAR MË SKEDAR:** Kontratat e funksioneve, tipet e të dhënave, logjika hap pas hapi dhe ruajtja e funksionalitetit ekzistues (mos fshi funksione që nuk lidhen me ndryshimin).
5. **HARDENING & EDGE CASES:** Trajtimi i rasteve `null/empty`, vlerave kufitare, Unicode, gabimeve I/O ose rrjeti, race conditions dhe ruajtjes së gjendjes.
6. **KRITERET E VERIFIKIMIT (DEFINITION OF DONE):** Çfarë duhet të kalojë në Build/Test që ndryshimi të konsiderohet i përfunduar.

Jep specifikim të qartë dhe determinist pa blloqe të gjata kodi.
