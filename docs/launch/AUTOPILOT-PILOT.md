# Pilote Guardian Autopilot — revue assistée d’un dépôt

**Statut :** brouillon d’offre, à valider avant toute proposition commerciale.
**Version prévue :** prestation manuelle et locale, pas un abonnement logiciel.

## Offre proposée

Une revue guidée d’un dépôt JavaScript/TypeScript appartenant au client. Guardian aide à inventorier les fichiers, résoudre des références locales et produire une liste expliquée de candidats à examiner. Le client garde la main sur le dépôt et sur chaque décision.

Le pilote peut inclure, seulement après consentement explicite, l’essai isolé d’au plus trois candidats dans une branche Git locale distincte. Les commandes de build, de typage et de test doivent être choisies et approuvées par le client. Elles s’exécutent avec les permissions de son compte, sans bac à sable système ; ne jamais les lancer pour un dépôt inconnu sans inspection et accord explicites.

## Client et adéquation

**Hypothèse de marché `{{NEEDS_PROOF}}` :** développeurs indépendants ou petites équipes qui maintiennent un dépôt JavaScript/TypeScript et veulent comprendre des fichiers candidats au nettoyage sans confier leur source à un service d’analyse hébergé.

Le pilote convient si le client possède ou est autorisé à faire examiner le dépôt, peut fournir un checkout Git propre et sait quelles commandes de vérification sont acceptables.

Refuser ou recadrer le pilote si le client attend une suppression garantie, un audit de sécurité exhaustif, un résultat de conformité, une PR automatique, l’analyse d’un dépôt hors JS/TS, ou l’exécution de commandes qu’il n’a pas inspectées.

## Périmètre et livrable

- Un dépôt local, choisi et contrôlé par le client.
- Analyse des références et candidats avec leurs preuves et incertitudes.
- Rapport de revue : chemins, raisons, protections rencontrées, limites et prochaine vérification humaine.
- Au plus trois expériences isolées, uniquement avec accord explicite sur les candidats et les commandes.
- Si une expérience réussit, remise du diff et des résultats de vérification pour décision du client. Pas de push, merge ni application silencieuse au checkout source.

L’issue peut être « aucun candidat assez sûr ». C’est un résultat valable, pas un échec à contourner.

## Ce que l’offre ne promet pas

- Le profil node-application-v1 peut produire une preuve positive d’inaccessibilité uniquement pour un dépôt privé Node.js admissible, propre, avec tous ses points d’entrée déclarés et sans configuration d’exécution non prise en charge. Cette preuve est relative aux points d’entrée déclarés, pas une garantie d’absence d’usage universelle ; beaucoup de dépôts seront bloqués ou resteront en revue seule.
- L’application réelle exige une confirmation par exécution, recalcule la preuve sur l’instantané Git et revalide le dépôt dans une branche de travail isolée avant de retirer un candidat. Une preuve absente ou un blocage interdit la suppression ; les commandes de vérification choisies et approuvées par le client restent des contrôles supplémentaires, pas une preuve d’absence d’usage externe.
- Aucune suppression, économie de temps, économie d’espace, compatibilité exhaustive ou absence de régression n’est garantie.
- L’intégration GitHub hébergée ne fait pas d’analyse du code et ne crée ni commit ni pull request.
- Un essai isolé n’est pas une preuve de sûreté pour tout usage externe ou dynamique du dépôt.
- Les commandes de préparation et de vérification peuvent accéder au réseau et aux fichiers autorisés au compte client ; l’environnement n’est pas un sandbox OS.

## Hypothèse de prix

**290 € pour le périmètre pilote ci-dessus — hypothèse à tester, non validée `{{NEEDS_PROOF}}`.** Ce montant n’est ni un tarif publié ni un lien de paiement. Les taxes, conditions, durée, disponibilité et mode de facturation restent à confirmer avant toute proposition ferme.

Le checkout Stripe présent dans le dépôt est en mode test. Ne pas l’envoyer à un client et ne pas présenter ce document comme une facture ou un contrat.

## Conditions d’acceptation à confirmer

1. Confirmer l’identité du propriétaire ou son autorisation d’examiner le dépôt.
2. Définir avec le client où le checkout sera exécuté et qui verra le rapport. Ne pas demander de clés, mots de passe, secrets ni données de clients.
3. Vérifier que le checkout Git est propre avant une expérience ; garder l’analyse seule comme option si ce n’est pas le cas.
4. Montrer au client les candidats et l’incertitude avant toute expérience.
5. Obtenir son accord explicite pour chaque candidat et la liste exacte des commandes à lancer.
6. Laisser le client décider d’un merge ou de toute modification de son dépôt.

Jusqu’à validation d’une politique de conservation, exécuter l’analyse sur le poste du client lorsque possible et ne pas conserver de clone, rapport ou diff au-delà de la remise sans accord distinct.

## Références internes

- [README — usage et garde-fous](../../README.md)
- [Sécurité et lancement](../SECURITY.md)
- [GitHub App — limite d’analyse locale](../GITHUB_APP.md)
- [Publication et versionnement](../RELEASING.md)
