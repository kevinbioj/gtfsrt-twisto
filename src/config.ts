/**
 * Endpoint SOAP du service SIRI de Twisto, et référence du demandeur qu'il attend.
 *
 * ⚠ À RENSEIGNER : le service n'est pas public, son adresse et son `RequestorRef` sont fournis par
 * l'exploitant. Les deux se laissent aussi passer par l'environnement — `SIRI_ENDPOINT` et
 * `REQUESTOR_REF` —, ce que fait le déploiement (cf. `compose.yaml`) pour ne pas les inscrire dans
 * l'image.
 */
export const SIRI_ENDPOINT = process.env.SIRI_ENDPOINT ?? "";
export const REQUESTOR_REF = process.env.REQUESTOR_REF ?? "";

/**
 * Clé d'API du portail qui protège le service, envoyée en en-tête `X-Gravitee-Api-Key`. Facultative :
 * laissée vide, aucune en-tête n'est ajoutée — le service se laisse alors interroger sans clé.
 */
export const SIRI_API_KEY = process.env.SIRI_API_KEY ?? "";

/**
 * Chemin d'une réponse `GetVehicleMonitoring` enregistrée, à rejouer au lieu d'interroger le service.
 * De quoi développer et vérifier le producteur sans endpoint — la péremption des relevés est alors
 * levée, l'enregistrement datant nécessairement d'avant (cf. {@link RECORD_STALENESS}).
 */
export const SIRI_FIXTURE_PATH = process.env.SIRI_FIXTURE_PATH;

/** Vrai lorsque le producteur rejoue un enregistrement au lieu d'interroger le service. */
export const FIXTURE_MODE = SIRI_FIXTURE_PATH !== undefined && SIRI_FIXTURE_PATH !== "";

export const PORT = 3000;

/** Délai au-delà duquel une requête SIRI est abandonnée. */
export const SIRI_TIMEOUT = Temporal.Duration.from({ seconds: 10 }).total("milliseconds");

/**
 * Cadence d'interrogation du service. La source annonce elle-même la durée de validité de ses
 * relevés — `ValidUntilTime`, trente secondes après `RecordedAtTime` — et interroger plus souvent ne
 * ferait que redemander la même donnée.
 */
export const POLL_INTERVAL = Temporal.Duration.from({ seconds: 60 }).total("milliseconds");

/**
 * Durée de validité de la liste des lignes suivies, rendue par `LinesDiscovery`. Le réseau ne change
 * pas d'une interrogation à l'autre : la redemander à chaque relevé doublerait les requêtes sans rien
 * apprendre de neuf.
 */
export const LINES_DISCOVERY_TTL = Temporal.Duration.from({ hours: 1 }).total("milliseconds");

export const STATIC_GTFS_URL =
	"https://data.twisto.fr/api/v2/catalog/datasets/fichier-gtfs-du-reseau-twisto/alternative_exports/gtfs_twisto_zip";

/**
 * Métadonnées du jeu de données, d'où se tire la date de publication du GTFS. L'archive elle-même ne
 * porte ni ETag ni `Last-Modified` — le portail la sert en `no-store` —, si bien que rien d'autre ne
 * permet de savoir qu'une nouvelle version est parue sans la retélécharger entièrement.
 */
export const STATIC_GTFS_METADATA_URL =
	"https://data.twisto.fr/api/explore/v2.1/catalog/datasets/fichier-gtfs-du-reseau-twisto";

/**
 * Intervalle de vérification de fraîcheur du GTFS statique : une simple requête HEAD compare la
 * signature (ETag/Last-Modified) et ne déclenche un retéléchargement que si le fichier a changé.
 * Fréquent à dessein — un GTFS périmé fait échouer la correspondance des courses et des arrêts.
 */
export const GTFS_CHECK_INTERVAL = Temporal.Duration.from({ minutes: 5 }).total("milliseconds");

/**
 * Âge au-delà duquel un relevé n'est plus repris, en secondes. Que la source cesse de réhorodater un
 * véhicule est un aveu : elle l'a perdu, et ce qu'elle en dit encore ne vaut plus d'être publié.
 */
export const RECORD_STALENESS = Temporal.Duration.from({ minutes: 10 }).total("seconds");

/**
 * Durée pendant laquelle un véhicule reste au feed après son dernier relevé, en secondes. Une position
 * n'est pas retirée parce que la source a cessé de la publier : un véhicule qui rentre au dépôt, une
 * course qui s'achève, un trou de couverture se ressemblent tous vus du producteur, et le consommateur
 * qui rafraîchit toutes les minutes doit pouvoir constater la fin d'un service plutôt que de voir le
 * véhicule s'évaporer entre deux relevés.
 */
export const VEHICLE_RETENTION = Temporal.Duration.from({ minutes: 30 }).total("seconds");

/**
 * Délai de garde d'une course, en secondes. Il court depuis son dernier relevé ET depuis sa fin
 * théorique : une course qui termine en avance cesse d'être publiée par la source alors que son horaire
 * la fait encore rouler, et la retirer aussitôt la ferait disparaître des écrans avant l'heure à
 * laquelle le voyageur l'attend. La plus tardive des deux échéances l'emporte (cf. `useRealtimeStore`).
 */
export const TRIP_RETENTION = Temporal.Duration.from({ minutes: 10 }).total("seconds");

/**
 * Retard minimal, en secondes, à partir duquel une course est tenue pour en retard — pour la reporter
 * sur les courses suivantes du même bloc comme pour la publier. En deçà, l'écart relève du bruit du
 * SAE, et l'annoncer ferait clignoter des prévisions qui ne disent rien.
 */
export const PROPAGATED_DELAY_MIN = 60;

/**
 * Nombre de courses du bloc sur lesquelles un retard est reporté, au plus. Le report suppose que le
 * conducteur ne rattrape rien, ce qui se vérifie sur la course suivante et de moins en moins ensuite :
 * une relève, une pause allongée ou un simple tour de roue plus vif finissent par effacer le retard, et
 * l'annoncer trois courses plus loin serait affirmer plus que ce que l'on sait.
 */
export const PROPAGATION_MAX_TRIPS = 3;

/**
 * Horizon du report, en secondes : une course qui part au-delà n'est pas annoncée. Le SAE reprendra la
 * main bien avant — il publie le véhicule dès sa prise de service —, et une prévision faite deux heures
 * à l'avance vaut moins que le silence.
 */
export const PROPAGATION_HORIZON = Temporal.Duration.from({ hours: 2 }).total("seconds");

/**
 * Incertitude déclarée sur les horaires reportés, en secondes (`uncertainty` du format). Elle distingue
 * une prévision déduite du bloc — que rien n'a observée — des horaires que le SAE annonce vraiment, et
 * laisse au consommateur de quoi les afficher différemment.
 */
export const PROPAGATED_UNCERTAINTY = 300;

/**
 * Distance restante, en mètres, en deçà de laquelle le véhicule est annoncé à quai. La source publie
 * cette distance pour son prochain arrêt (`DistanceFromStop`), ce qui dispense de tout calcul
 * géométrique — et de charger les tracés du GTFS.
 */
export const STOPPED_AT_DISTANCE = 30;

/** Distance restante, en mètres, en deçà de laquelle le véhicule est annoncé en approche. */
export const INCOMING_AT_DISTANCE = 100;

/**
 * Avancement, en pourcentage du tronçon entre deux arrêts, au-delà duquel le véhicule est tenu pour
 * arrivé. La source le publie (`ProgressBetweenStops`) et le porte à 100 avant que la distance ne
 * tombe sous le seuil du « à quai » — les deux se complètent.
 */
export const STOPPED_AT_PROGRESS = 99;

export const TIME_ZONE = "Europe/Paris";

/** Préfixe des identifiants d'entités du feed (« VM:TWISTO:… », « ET:TWISTO:… »). */
export const FEED_PREFIX = "TWISTO";

/**
 * Heure locale avant laquelle une course sans correspondance dans le GTFS est rattachée à la journée
 * de service de la VEILLE. Une course supplémentaire partie à 00h30 relève du service de la soirée
 * précédente, que le GTFS écrirait « 24:30:00 » ; sans cette convention, elle serait annoncée un jour
 * trop tard.
 */
export const NIGHT_SERVICE_CUTOFF_HOUR = 4;

/**
 * Journées de service auxquelles une course annoncée peut appartenir, en décalage de jours. Les
 * journées se chevauchent : à minuit passé, celle d'hier est encore ouverte, et une course annoncée
 * pour « 00:10 » peut déjà relever de demain.
 */
export const CANDIDATE_DAY_OFFSETS = [0, -1, 1] as const;
