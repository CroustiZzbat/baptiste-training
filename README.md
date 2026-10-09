# Baptiste Training — V5

Appli 100 % navigateur (React + Vite). Aucune dépendance à ChatGPT, aucun serveur.

## Nouveautés V5
- « Je ne peux pas y aller » : garder la séance pour plus tard, ou la marquer « manquée » (hors stats et hors perfs).
- Toucher un jour à venir du planning : y aller directement, les jours sautés sont notés manqués / repos.
- « Dernière fois » sur chaque exercice (valeurs par série, variante, lest, RPE) + record personnel.
- Rappel « préc. X » sur chaque série et écart (+2 / = / −1) dès que tu tapes ta valeur.
- Dernière perf visible aussi dans l'onglet Programme.
- Durée de séance = temps réellement actif (les pauses de plus de 20 min ne comptent plus).
- Bouton « Abandonner la séance » + alerte si une séance est restée ouverte.
- Import des sauvegardes V4 (ChatGPT) : les séances vides validées deviennent « manquées », les durées faussées sont effacées.

## Mettre en ligne
Le dossier `docs/` (généré par `npm run build`) est publié par GitHub Pages : Settings → Pages → branche main, dossier /docs (index.html autonome + manifest, service worker, icônes).
Netlify Drop, GitHub Pages ou n'importe quel hébergeur statique.

## Développer
npm install · npm run dev · npm run build
