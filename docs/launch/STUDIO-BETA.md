# Bêta Guardian Studio — session locale guidée

**Statut :** invitation à une bêta exploratoire ; pas une offre de nettoyage automatique d’archives.

## Session proposée

Une session guidée où le créateur utilise Studio sur son propre ordinateur et choisit lui-même un dossier de test. Le scan reste en lecture seule. L’archivage est une opération distincte et facultative : l’utilisateur sélectionne des fichiers, lit leurs chemins et tailles dans la page, puis lance l’archivage. Après autorisation d’écriture, Guardian crée `Corbeille` dans le dossier sélectionné, copie et vérifie les fichiers et son journal avant de retirer les originaux sélectionnés. Une restauration est possible ; la suppression définitive dans Corbeille est une action séparée, avec liste et case de confirmation en ligne.

Les images et métadonnées sont lues localement. Si l’utilisateur archive des fichiers, leurs copies et le journal contenant chemins, raisons, tailles et hashes persistent dans le dossier d’archive choisi. Rien n’est téléversé ; la page de lancement ne reçoit aucun fichier.

**Hypothèse de marché `{{NEEDS_PROOF}}` :** créateurs utilisant Stable Diffusion WebUI ou ComfyUI qui souhaitent comprendre la composition d’une archive d’images avant de décider quoi examiner.

## Ce qui peut être essayé

- Inventaire local des images prises en charge : PNG, JPEG, WebP, GIF, AVIF et SVG.
- Repérage des doublons exacts : taille, SHA-256 et comparaison des octets. Des candidats visuellement similaires sont aussi suggérés séparément pour les PNG, JPEG, WebP et AVIF ; ce signal heuristique peut avoir des faux positifs.
- Repérage des images volumineuses, sans en faire une recommandation d’effacement.
- Pour le PNG sélectionné seulement, lecture bornée de certains chunks texte `tEXt` et `iTXt` non compressés, dont les champs `parameters`, `prompt` et `workflow` reconnus par l’application.
- Affichage volontaire des valeurs de métadonnées, qui peuvent contenir des prompts privés.
- Export facultatif d’un plan de revue JSON contenant les chemins relatifs et tailles sélectionnés ; aucune image n’y est intégrée.

Les métadonnées des JPEG, WebP et autres formats ne sont pas analysées. Les chunks compressés ne sont pas décodés. Le parseur PNG lit au plus 1 Mio ; le hash exact est limité à 64 Mio par fichier et l’interface conserve au plus 10 000 images pour la revue. Les limites et scans partiels sont signalés. La démo fournie est synthétique et ne démontre pas le comportement sur toutes les archives réelles.

## Limites à annoncer

- Aucun scan ne modifie les images et aucune suppression automatique n’existe. L’archivage retire de la source uniquement les fichiers sélectionnés après copie et vérification dans Corbeille ; restauration et suppression définitive restent des actions séparées.
- Un doublon exact signifie mêmes octets, pas même apparence ou même valeur artistique.
- Les « fichiers volumineux » et les estimations d’espace ne sont pas des économies réalisées.
- Il n’y a pas d’index global des prompts ni de catalogue persistant. Le plan de revue peut être exporté sur demande ; le journal et les copies d’archive persistent uniquement dans le dossier choisi.
- Guardian ne mesure pas l’espace libre du système. Une archive sur le même volume ne récupère pas d’espace tant que ses copies ne sont pas purgées.
- Ne pas demander à l’invité d’envoyer son archive, ses images ou ses prompts. Commencer avec les exemples synthétiques si la personne préfère.

## Hypothèse de prix

**29 € pour une session bêta guidée — hypothèse à tester, non validée `{{NEEDS_PROOF}}`.** Aucun paiement n’est pris par Studio ou par la page de lancement. Ne pas la présenter comme un tarif établi, un produit final ou une promesse d’espace récupéré. Disponibilité, conditions et mode de facturation sont à confirmer séparément avant tout engagement.

## Retour à recueillir

Demander à l’invité, sans conserver ses images ni prompts :

- Qu’a-t-il compris de la vue « doublon exact » ?
- Quelle décision concrète a-t-il pu prendre à partir de l’inventaire ?
- Quelle information manque pour examiner une image avec confiance ?
- Est-ce que la lecture de métadonnées sur un PNG sélectionné lui paraît utile et suffisamment discrète ?
- Reviendrait-il à l’outil, et pour quel travail précis ?

Ne transformer aucun commentaire en témoignage public sans autorisation séparée.

## Références internes

- [Périmètre fonctionnel et limites](../STUDIO-PRD.md)
- [Vérification réalisée et non réalisée](../STUDIO-DESIGN-QA.md)
- [Contrat UX](../../UX-CONTRACT.md)
