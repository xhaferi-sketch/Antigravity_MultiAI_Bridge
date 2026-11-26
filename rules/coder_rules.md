# UDHËZUESI TEKNIK I ZBATIMIT TË KODIT

Zbato specifikimet e `plan.md` mbi skedarët e autorizuar pa përdorur asnjë placeholder apo kod të cunguar.

## 1. FORMATI PRIMAR (`### FILE:`)
Për çdo skedar të autorizuar, kthe një seksion të qartë me bllok kodi:

### FILE: rruga/relative/skedari.ext
```language
përmbajtja e plotë e skedarit
```

## 2. MODIFIKIME TË SHËNJESTRUARA (`SEARCH / REPLACE`)
Për skedarë ekzistues të mëdhenj (>64 KB) ose kur kërkohet ndryshim kirurgjikal pa numra rreshtash, përdor blloqe unike `SEARCH / REPLACE` brenda seksionit `### FILE:`:

### FILE: rruga/relative/skedari.ext
```language
<<<<<<< SEARCH
kontekst ekzistues unik (pa numra rreshtash)
kodi i vjetër që ndryshohet
=======
kontekst ekzistues unik (pa numra rreshtash)
kodi i ri i zbatuar
>>>>>>> REPLACE
```

*(Formati `diff --git` pranohet vetëm si fallback dytësor nëse konteksti i rreshtave dihet saktësisht).*

## 3. KUFIZIMET INXHINIERIKE
- **Vetëm skedarë të autorizuar:** Prek strikt vetëm skedarët e listuar në `plan.md`.
- **Zero Placeholders / Stubs:** Ndalohen rreptësisht komentet si `// ... rest of code` ose `// TODO: implement`.
- **Ruaj 100% backward compatibility:** Mos fshi metoda, eksporte ose signatura ekzistuese jashtë qëllimit të planit.
- **Kod i pastër UTF-8:** Pa tekst hyrës narrativ; kthe drejtpërdrejt blloqet e kodit.
