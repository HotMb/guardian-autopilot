# Playbook pilote — jeudi 15 octobre 2026

**Fuseau :** Europe/Paris.
**Statut :** plan à exécuter ; aucun prospect, rendez-vous, vente ou paiement n’est présumé acquis.

## Résultat réaliste de la journée

Valider qu’une personne comprend une offre et accepter, si les conditions opérationnelles sont prêtes, un petit pilote payé. Un message envoyé, une conversation ou un prix exploratoire ne constituent pas une vente. Si le contact, les conditions ou la facturation ne sont pas prêts, le résultat honnête est un rendez-vous de découverte et une liste d’incertitudes.

**Hypothèse d’acquisition `{{NEEDS_PROOF}}` :** commencer par cinq contacts chaleureux et pertinents plutôt que par une campagne large. Ce nombre est un test de prospection, pas une estimation de conversion.

## Avant de contacter quelqu’un

- Choisir le parcours correspondant à la personne : Autopilot pour un dépôt JS/TS ; Studio pour un créateur d’images IA. Ne pas regrouper les deux besoins dans une seule offre.
- Confirmer un canal de retour réel. Le HTML ne connaît pas d’adresse, ne contient pas de formulaire et ne transmet rien : il copie un texte que l’utilisateur colle lui-même dans le canal où il a reçu la page.
- Si une vente payante est envisagée, vérifier d’abord que l’opérateur peut confirmer le prix, le périmètre, les conditions, le support et un moyen légitime de facturation/paiement. Les prix ci-dessous restent des hypothèses `{{NEEDS_PROOF}}`.
- Ne pas utiliser le Checkout Stripe de test pour encaisser. Le dépôt indique que le paiement réel et le fulfillment client ne sont pas activés.
- Ne pas demander de secrets, de données personnelles inutiles, de dépôt privé à téléverser ou d’archive d’images à envoyer.

## Déroulé proposé

| Heure | Action | Critère de sortie |
|---|---|---|
| 09:00 | Relire les deux fiches d’offre et vérifier le périmètre réellement disponible. | Aucun résultat ou prix présenté comme validé. |
| 09:30 | Lister jusqu’à cinq personnes déjà connues et potentiellement concernées `{{NEEDS_PROOF}}`. | Chaque personne correspond à une seule clientèle ; aucune liste de données achetée ou aspirée. |
| 10:00 | Envoyer un message individuel et demander l’autorisation d’un échange bref. | Pas de promesse de suppression, de gain de place ou de paiement en ligne. |
| 12:00 | Qualifier les réponses ; ne pas demander de dépôt ou d’images à cette étape. | Poursuivre uniquement si le besoin et l’autorisation sont clairs. |
| 14:00 | Si une personne est qualifiée, confirmer le périmètre, les limites, la confidentialité, les conditions et le prix avant l’acceptation. | Accord explicite conservé par le canal convenu ; sinon rester en découverte. |
| 15:00 | Réaliser au plus une session pilote si toutes les conditions sont réunies. | Autopilot : commandes choisies et approuvées par le client ; Studio : dossier choisi localement par l’invité. |
| 17:00 | Remettre un résumé des observations et demander un retour privé. | Les faits observés sont séparés des hypothèses ; aucun témoignage public sans autorisation. |
| 17:30 | Consigner les métriques anonymisées et décider de la prochaine expérience. | Noter réponses, besoins, objections, durée opérateur et volonté de payer, pas le code, les images ou prompts. |

## Message à copier — Guardian Autopilot

> Bonjour, je teste un pilote manuel Guardian Autopilot pour examiner un dépôt JavaScript/TypeScript localement. Le livrable est un rapport qui explique les candidats et leurs incertitudes. Aucune suppression n’est garantie. Un essai isolé, limité à trois candidats maximum, ne se fait qu’après ton accord explicite et avec les commandes de vérification que tu choisis. Le prix exploratoire envisagé est 290 € (`{{NEEDS_PROOF}}`), non validé et sans paiement en ligne sur cette page. Est-ce que ce sujet t’intéresse pour un échange de découverte ? Merci de ne pas envoyer de secret ni de code privé dans ta réponse.

## Message à copier — Guardian Studio

> Bonjour, je cherche des créateurs Stable Diffusion WebUI ou ComfyUI pour une session bêta locale de Guardian Studio. On peut examiner un inventaire, des doublons exacts, des candidats visuels heuristiques et certains champs de métadonnées PNG. Si tu le souhaites, l’outil peut archiver des fichiers choisis après une autorisation séparée et une confirmation précise ; il ne nettoie rien automatiquement et ne garantit pas d’espace récupéré. Le prix exploratoire envisagé est 29 € (`{{NEEDS_PROOF}}`), non validé et sans paiement en ligne sur cette page. La session se fait sur ton ordinateur ; ne m’envoie ni images ni prompts. Est-ce que tu serais partant·e pour donner un retour ?

## Qualification et accord

### Pour Autopilot

1. Le dépôt est-il en JavaScript/TypeScript et le répondant en possède-t-il le droit d’accès ?
2. Quel problème essaie-t-il de résoudre ? Demander le contexte, pas les sources.
3. Peut-il travailler dans un checkout propre et examiner ses commandes de build, typecheck et test ?
4. Accepte-t-il que l’analyse puisse conclure qu’aucun candidat n’est assez étayé ?
5. Avant une expérience : confirmer les chemins exacts, les commandes exactes, leur exécution avec les permissions de son compte et l’absence de push/merge automatique.

Sans accord explicite sur la commande et les candidats, s’arrêter au rapport en lecture seule.

### Pour Studio

1. Le besoin concerne-t-il un inventaire d’images IA local, plutôt que du rangement automatique ou une recherche de ressemblance ?
2. L’invité est-il à l’aise pour ouvrir l’application sur son propre poste et sélectionner lui-même un dossier de test ?
3. Commencer par la démo synthétique si la personne ne veut pas sélectionner de données réelles.
4. Ne jamais demander les images, chemins complets, prompts privés ou exports d’archive.

## Réponses aux objections

**« Guardian va supprimer les fichiers inutiles ? »**

Non. L’analyse peut proposer une revue, mais l’absence de référence détectée n’est pas une preuve que le fichier est inutilisé. Aucune suppression ne sera promise.

**« Peux-tu me garantir que les tests n’ont rien cassé ? »**

Les vérifications choisies par le client donnent des éléments utiles, pas une preuve de l’absence de tout usage externe, dynamique ou non testé.

**« Mon code ou mes images sont-ils envoyés ? »**

Les parcours décrits sont locaux. La page de lancement ne collecte ni ne transmet rien. Ne pas demander un téléversement ; toute conservation future demanderait une politique séparée.

**« Studio reconnaît les images similaires et récupère de l’espace ? »**

Il propose des candidats visuels heuristiques pour certains formats, pas une reconnaissance sémantique. Les doublons exacts sont vérifiés par les octets. Il ne nettoie rien automatiquement : tu sélectionnes les fichiers, vérifies leurs chemins et tailles, puis autorises l’écriture sur le dossier choisi. Guardian copie et vérifie dans une Corbeille locale avant de retirer les originaux. Restauration et suppression définitive sont distinctes. Guardian ne choisit pas quelle image a une valeur et ne mesure pas l’espace libre du système.

**« Pourquoi payer avant que le SaaS soit fini ? »**

Ne pas vendre un SaaS fini. Présenter le prix comme hypothèse de pilote manuel ; si le prix, les conditions ou le paiement ne sont pas prêts, proposer une découverte sans paiement et noter l’objection.

## Livraison minimale

- **Autopilot :** résumé de la portée, candidats et preuves, limites, commandes réellement exécutées avec accord, résultats, diff local éventuel et prochaine décision du client. Ne pas pousser ni fusionner.
- **Studio :** notes d’usage sans images/prompts, formats testés, fonctions comprises, erreurs observées et demandes. Pas de promesse de rangement ou d’espace récupéré.
- Conserver les données client uniquement selon une durée explicitement convenue et validée par l’opérateur. En l’absence de cette décision, ne pas accepter de copie hébergée ni d’archive à conserver.

## Bilan de fin de journée

Noter : personnes contactées et réponses, conversations qualifiées, problèmes réels entendus, objections, demandes de fonctionnalités, décisions de prix, temps passé et éventuel accord au pilote. Distinguer chaque observation de l’hypothèse `{{NEEDS_PROOF}}`; ne pas inventer clients, témoignages, taux de conversion ou compatibilité.

Un premier paiement n’est envisageable que si le propriétaire a confirmé les conditions, la facturation et le moyen de paiement appropriés. Le dépôt ne fournit pas un checkout production prêt à encaisser.
