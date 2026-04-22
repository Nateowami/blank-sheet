"""
evaluate_language_similarity.py — measure accuracy of language_similarity.py
on the eBible corpus.

How the evaluation works
------------------------
1.  Load the eBible corpus and group verses by ISO language code.
2.  Discard languages with fewer than ``--min-verses`` verses (too little data
    for a reliable mini-corpus).
3.  Repeat ``--trials`` times:
      * With probability 0.5, draw two mini-corpora from the *same* language.
      * With probability 0.5, draw one mini-corpus from each of two *different*
        randomly selected languages.
      * Call :func:`same_language` and compare with the ground truth.
4.  Report:
      - False positive rate  (different languages classified as same)
      - False negative rate  (same language classified as different)
      - Overall accuracy
      - Average similarity scores for same-language and different-language pairs
      - An optimal threshold sweep (so you can tune ``--threshold``)

Data sources  (``--source``)
-----------------------------
``huggingface`` (default)
    Downloads ``bible-nlp/biblenlp-corpus`` from HuggingFace.
    Requires:  ``pip install datasets``

``ebible-dir``
    Loads from a locally cloned copy of https://github.com/BibleNLP/ebible.
    Point ``--ebible-dir`` at the ``corpus/`` sub-directory (which contains
    files named ``<lang>-<translation>.txt``, one verse per line).
    No extra packages required.

``synthetic``
    Uses built-in multilingual text samples to demonstrate the evaluation
    methodology without any network access or extra packages.

Usage
-----
    # HuggingFace (requires network + datasets package):
    pip install datasets
    python evaluate_language_similarity.py

    # Local eBible clone (--source is inferred automatically):
    git clone https://github.com/BibleNLP/ebible
    python evaluate_language_similarity.py --ebible-dir ebible/corpus

    # Built-in synthetic demo (no network or extra packages needed):
    python evaluate_language_similarity.py --source synthetic

    # Tune the decision threshold:
    python evaluate_language_similarity.py --threshold 0.6 --source synthetic
"""

import argparse
import os
import random
import sys
from collections import defaultdict

from language_similarity import same_language, similarity_score


# ---------------------------------------------------------------------------
# Data loading — HuggingFace
# ---------------------------------------------------------------------------

def load_from_huggingface(min_verses: int = 200,
                          max_languages: int | None = None) -> dict:
    """Download and return the eBible corpus from HuggingFace.

    Returns ``{lang_code: [verse_string, ...]}``
    """
    try:
        from datasets import load_dataset  # type: ignore
    except ImportError:
        sys.exit(
            "The 'datasets' package is required.  Install it with:\n"
            "    pip install datasets"
        )

    print("Loading eBible corpus from HuggingFace (this may take a while)…")
    ds = load_dataset("bible-nlp/biblenlp-corpus", split="train")

    by_lang: dict = defaultdict(list)
    for row in ds:
        text = row["text"].strip()
        if text:
            by_lang[row["lang"]].append(text)

    return _filter_languages(dict(by_lang), min_verses, max_languages)


# ---------------------------------------------------------------------------
# Data loading — local eBible corpus directory
# ---------------------------------------------------------------------------

def load_from_ebible_dir(corpus_dir: str,
                         min_verses: int = 200,
                         max_languages: int | None = None) -> dict:
    """Load eBible text files from a local directory.

    The directory should contain files named ``<lang>-<translation>.txt``
    (one verse per line), as found in the ``corpus/`` folder of the eBible
    GitHub repository (https://github.com/BibleNLP/ebible).

    When multiple translations exist for the same ISO language code they are
    merged together.

    Returns ``{lang_code: [verse_string, ...]}``
    """
    if not os.path.isdir(corpus_dir):
        sys.exit(f"Directory not found: {corpus_dir}")

    by_lang: dict = defaultdict(list)
    n_files = 0
    for filename in os.listdir(corpus_dir):
        if not filename.endswith(".txt"):
            continue
        # filename format: <lang>-<translation>.txt  (e.g. eng-engkjv.txt)
        lang = filename.split("-")[0]
        filepath = os.path.join(corpus_dir, filename)
        with open(filepath, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                verse = line.strip()
                if verse:
                    by_lang[lang].append(verse)
        n_files += 1

    if n_files == 0:
        sys.exit(f"No .txt files found in {corpus_dir}")
    print(f"Loaded {n_files} translation files from {corpus_dir}.")

    return _filter_languages(dict(by_lang), min_verses, max_languages)


# ---------------------------------------------------------------------------
# Data loading — built-in synthetic data
# ---------------------------------------------------------------------------

# Number of times each synthetic sentence is repeated to build a corpus large
# enough for character n-gram distributions to be representative.
_SYNTHETIC_SENTENCE_REPETITIONS = 50

# Representative sentences for a handful of languages drawn from
# publicly-available translations of short texts.  Each entry is (lang_code,
# text_snippet); snippets are repeated to build mini-corpora.
_SYNTHETIC_SENTENCES: list[tuple[str, str]] = [
    # English
    ("eng", "the cat sat on the mat and looked at the hat in the garden"),
    ("eng", "the quick brown fox jumps over the lazy dog near the barn"),
    ("eng", "she walked through the forest and found a small clear river"),
    ("eng", "the children played in the park while their parents watched"),
    ("eng", "he opened the door and stepped inside the warm comfortable room"),
    ("eng", "the sun set slowly behind the mountains casting long shadows"),
    ("eng", "a horse of a different color ran through the open green field"),
    ("eng", "for the love of the game they practiced every single day"),
    ("eng", "under the stars they danced until the night was almost over"),
    ("eng", "the old man told stories of distant lands and faraway places"),
    # Spanish
    ("spa", "el gato se sentó en la alfombra y miró el sombrero"),
    ("spa", "el rápido zorro marrón salta sobre el perro perezoso"),
    ("spa", "ella caminó por el bosque y encontró un pequeño río"),
    ("spa", "los niños jugaron en el parque mientras sus padres miraban"),
    ("spa", "él abrió la puerta y entró en la cálida habitación cómoda"),
    ("spa", "el sol se puso lentamente detrás de las montañas"),
    ("spa", "un caballo de un color diferente corrió por el campo verde"),
    ("spa", "por el amor del juego practicaban todos los días sin falta"),
    ("spa", "bajo las estrellas bailaron hasta que la noche casi terminó"),
    ("spa", "el anciano contaba historias de tierras lejanas y lugares remotos"),
    # French
    ("fra", "le chat était assis sur le tapis et regardait le chapeau"),
    ("fra", "le rapide renard brun saute par-dessus le chien paresseux"),
    ("fra", "elle marcha à travers la forêt et trouva une petite rivière"),
    ("fra", "les enfants jouèrent dans le parc pendant que leurs parents regardaient"),
    ("fra", "il ouvrit la porte et entra dans la chambre chaude et confortable"),
    ("fra", "le soleil se couchait lentement derrière les montagnes"),
    ("fra", "un cheval d'une couleur différente courut à travers le champ vert"),
    ("fra", "par amour du jeu ils s'entraînaient chaque jour sans faute"),
    ("fra", "sous les étoiles ils dansèrent jusqu'à ce que la nuit soit presque finie"),
    ("fra", "le vieil homme racontait des histoires de terres lointaines"),
    # German
    ("deu", "die Katze saß auf der Matte und schaute auf den Hut"),
    ("deu", "der schnelle braune Fuchs springt über den faulen Hund"),
    ("deu", "sie wanderte durch den Wald und fand einen kleinen klaren Fluss"),
    ("deu", "die Kinder spielten im Park während ihre Eltern zuschauten"),
    ("deu", "er öffnete die Tür und trat in das warme gemütliche Zimmer"),
    ("deu", "die Sonne versank langsam hinter den Bergen und warf lange Schatten"),
    ("deu", "ein Pferd einer anderen Farbe lief durch das offene grüne Feld"),
    ("deu", "aus Liebe zum Spiel trainierten sie jeden einzelnen Tag"),
    ("deu", "unter den Sternen tanzten sie bis die Nacht fast vorbei war"),
    ("deu", "der alte Mann erzählte Geschichten von fernen Ländern"),
    # Russian (Cyrillic)
    ("rus", "кошка сидела на коврике и смотрела на шляпу в саду"),
    ("rus", "быстрая коричневая лиса прыгает через ленивую собаку"),
    ("rus", "она шла через лес и нашла маленькую чистую реку"),
    ("rus", "дети играли в парке пока их родители смотрели"),
    ("rus", "он открыл дверь и зашёл в тёплую уютную комнату"),
    ("rus", "солнце медленно садилось за горами бросая длинные тени"),
    ("rus", "лошадь другого цвета бежала по открытому зелёному полю"),
    ("rus", "из любви к игре они тренировались каждый день без остановки"),
    ("rus", "под звёздами они танцевали пока ночь почти не закончилась"),
    ("rus", "старик рассказывал истории о далёких землях и местах"),
    # Arabic
    ("ara", "الثعلب البني السريع يقفز فوق الكلب الكسول في الحديقة"),
    ("ara", "القط جلس على الحصيرة ونظر إلى القبعة بالقرب منه"),
    ("ara", "مشت عبر الغابة ووجدت نهراً صغيراً صافياً جميلاً"),
    ("ara", "لعب الأطفال في الحديقة بينما راقبهم والداهم من بعيد"),
    ("ara", "فتح الباب ودخل إلى الغرفة الدافئة والمريحة جداً"),
    ("ara", "غربت الشمس ببطء خلف الجبال وألقت ظلالاً طويلة"),
    ("ara", "حصان بلون مختلف ركض عبر الحقل الأخضر المفتوح"),
    ("ara", "من أجل حب اللعبة تدربوا كل يوم واحد بعد الآخر"),
    ("ara", "تحت النجوم رقصوا حتى كادت الليلة أن تنتهي"),
    ("ara", "روى الرجل العجوز قصصاً عن أراضٍ بعيدة وأماكن نائية"),
    # Swahili
    ("swh", "paka alikaa juu ya mkeka na alitazama kofia kwenye bustani"),
    ("swh", "mbweha wa kahawia haraka anakimbia juu ya mbwa mvivu"),
    ("swh", "alitembea msituni na kupata mto mdogo wa maji safi"),
    ("swh", "watoto walicheza bustanini wakati wazazi wao waliangalia"),
    ("swh", "alifungua mlango na kuingia ndani ya chumba cha joto"),
    ("swh", "jua lilikwenda polepole nyuma ya milima na kutupa vivuli"),
    ("swh", "farasi wa rangi tofauti alikimbia kwenye uwanja wa kijani"),
    ("swh", "kwa upendo wa mchezo walifanya mazoezi kila siku bila kukosa"),
    ("swh", "chini ya nyota walicheza ngoma mpaka usiku ukaisha"),
    ("swh", "mzee alisimulia hadithi za nchi za mbali na maeneo ya mbali"),
    # Chinese (Simplified)
    ("zho", "猫坐在垫子上看着帽子在花园里"),
    ("zho", "快速的棕色狐狸跳过了懒惰的狗"),
    ("zho", "她穿过森林走着发现了一条清澈的小河"),
    ("zho", "孩子们在公园里玩耍父母在旁边看着"),
    ("zho", "他打开门走进温暖舒适的房间"),
    ("zho", "太阳慢慢地落在山后面投下长长的阴影"),
    ("zho", "一匹不同颜色的马跑过开阔的绿色田野"),
    ("zho", "出于对游戏的热爱他们每天都在练习"),
    ("zho", "在星空下他们跳舞直到夜晚快结束"),
    ("zho", "老人讲述了遥远土地和地方的故事"),
    # Hindi
    ("hin", "बिल्ली चटाई पर बैठी और बगीचे में टोपी की तरफ देखी"),
    ("hin", "तेज भूरी लोमड़ी आलसी कुत्ते के ऊपर कूदती है"),
    ("hin", "वह जंगल से गुज़री और एक छोटी साफ नदी मिली"),
    ("hin", "बच्चे पार्क में खेले जबकि माता पिता देखते रहे"),
    ("hin", "उसने दरवाज़ा खोला और गर्म आरामदायक कमरे में कदम रखा"),
    ("hin", "सूर्य धीरे धीरे पहाड़ों के पीछे डूब गया लंबी छाया डालता"),
    ("hin", "एक अलग रंग का घोड़ा खुले हरे मैदान से गुज़रा"),
    ("hin", "खेल के प्यार के लिए वे हर एक दिन बिना रुके अभ्यास करते थे"),
    ("hin", "तारों के नीचे वे नाचे जब तक रात लगभग खत्म न हो गई"),
    ("hin", "बूढ़े आदमी ने दूर देशों और स्थानों की कहानियाँ सुनाईं"),
]


def load_synthetic(min_verses: int = 5,
                   max_languages: int | None = None) -> dict:
    """Build a corpus from the built-in multilingual sentence list.

    Returns ``{lang_code: [sentence_string, ...]}``
    """
    by_lang: dict = defaultdict(list)
    for lang, sentence in _SYNTHETIC_SENTENCES:
        by_lang[lang].extend([sentence] * _SYNTHETIC_SENTENCE_REPETITIONS)

    return _filter_languages(dict(by_lang), min_verses, max_languages)


# ---------------------------------------------------------------------------
# Shared helper
# ---------------------------------------------------------------------------

def _filter_languages(by_lang: dict,
                      min_verses: int,
                      max_languages: int | None) -> dict:
    filtered = {
        lang: verses
        for lang, verses in by_lang.items()
        if len(verses) >= min_verses
    }
    print(f"Found {len(filtered)} languages with ≥{min_verses} verses each.")

    if max_languages and len(filtered) > max_languages:
        keys = random.sample(sorted(filtered), max_languages)
        filtered = {k: filtered[k] for k in keys}
        print(f"Subsampled to {max_languages} languages.")

    return filtered


# ---------------------------------------------------------------------------
# Corpus sampling
# ---------------------------------------------------------------------------

def _build_mini_corpus(verses: list, size: int, rng: random.Random) -> str:
    """Sample *size* verses (with replacement) and concatenate them."""
    return " ".join(rng.choices(verses, k=size))


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------

def evaluate(
    by_lang: dict,
    n_trials: int = 1000,
    corpus_size: int = 50,
    threshold: float = 0.5,
    seed: int = 42,
    sweep_thresholds: bool = True,
) -> dict:
    """Run evaluation trials and return result statistics.

    Parameters
    ----------
    by_lang:
        ``{lang_code: [verse_string, ...]}``
    n_trials:
        Total number of test pairs to evaluate.
    corpus_size:
        Number of verses/sentences to concatenate into each mini-corpus.
    threshold:
        Decision boundary passed to :func:`same_language`.
    seed:
        Random seed for reproducibility.
    sweep_thresholds:
        If True, also find the threshold that minimises FP rate + FN rate.

    Returns
    -------
    dict
        Evaluation statistics.
    """
    rng = random.Random(seed)
    languages = sorted(by_lang.keys())

    if len(languages) < 2:
        sys.exit("Need at least 2 languages to evaluate.")

    all_scores: list = []   # list of (score: float, is_same: bool)

    print(f"\nRunning {n_trials} trials…")
    for i in range(n_trials):
        is_same = rng.random() < 0.5

        if is_same:
            lang = rng.choice(languages)
            c1 = _build_mini_corpus(by_lang[lang], corpus_size, rng)
            c2 = _build_mini_corpus(by_lang[lang], corpus_size, rng)
        else:
            lang1, lang2 = rng.sample(languages, 2)
            c1 = _build_mini_corpus(by_lang[lang1], corpus_size, rng)
            c2 = _build_mini_corpus(by_lang[lang2], corpus_size, rng)

        score = similarity_score(c1, c2)
        all_scores.append((score, is_same))

        if (i + 1) % 100 == 0:
            print(f"  {i + 1}/{n_trials} done…")

    # -----------------------------------------------------------------------
    # Confusion matrix at the requested threshold
    # -----------------------------------------------------------------------
    tp = fp = tn = fn = 0
    for score, is_same in all_scores:
        predicted_same = score >= threshold
        if is_same and predicted_same:
            tp += 1
        elif is_same and not predicted_same:
            fn += 1
        elif not is_same and not predicted_same:
            tn += 1
        else:
            fp += 1

    n_same = tp + fn
    n_diff = tn + fp

    fp_rate = fp / n_diff if n_diff else 0.0
    fn_rate = fn / n_same if n_same else 0.0
    accuracy = (tp + tn) / n_trials

    scores_same = [s for s, same in all_scores if same]
    scores_diff = [s for s, same in all_scores if not same]
    avg_same = sum(scores_same) / len(scores_same) if scores_same else float("nan")
    avg_diff = sum(scores_diff) / len(scores_diff) if scores_diff else float("nan")

    _print_results(threshold, n_trials, n_same, n_diff, tp, fn, tn, fp,
                   fp_rate, fn_rate, accuracy, avg_same, avg_diff)

    best_threshold = threshold
    if sweep_thresholds:
        best_threshold = _sweep(all_scores, n_same, n_diff, n_trials)

    return {
        "threshold": threshold,
        "n_trials": n_trials,
        "n_same": n_same,
        "n_diff": n_diff,
        "true_positives": tp,
        "false_negatives": fn,
        "true_negatives": tn,
        "false_positives": fp,
        "fp_rate": fp_rate,
        "fn_rate": fn_rate,
        "accuracy": accuracy,
        "avg_similarity_same_language": avg_same,
        "avg_similarity_diff_language": avg_diff,
        "optimal_threshold": best_threshold,
    }


def _print_results(threshold, n_trials, n_same, n_diff, tp, fn, tn, fp,
                   fp_rate, fn_rate, accuracy, avg_same, avg_diff) -> None:
    sep = "=" * 55
    print(f"\n{sep}")
    print(f"Evaluation results  (threshold = {threshold})")
    print(sep)
    print(f"Trials : {n_trials}  ({n_same} same-language, {n_diff} different-language)")
    print(f"\nConfusion matrix:")
    print(f"  True positives  (same  → same)     : {tp:5d}")
    print(f"  False negatives (same  → different) : {fn:5d}")
    print(f"  True negatives  (diff  → different) : {tn:5d}")
    print(f"  False positives (diff  → same)      : {fp:5d}")
    print(f"\nFalse positive rate : {fp_rate:.3f}  ({fp}/{n_diff})")
    print(f"False negative rate : {fn_rate:.3f}  ({fn}/{n_same})")
    print(f"Accuracy            : {accuracy:.3f}")
    print(f"\nMean similarity — same language : {avg_same:.4f}")
    print(f"Mean similarity — diff language : {avg_diff:.4f}")


def _sweep(all_scores: list, n_same: int, n_diff: int, n_trials: int) -> float:
    """Find and report the threshold that minimises FP rate + FN rate."""
    candidates = sorted({s for s, _ in all_scores})
    best_err = float("inf")
    best_t = candidates[0]

    for t in candidates:
        tp = sum(1 for s, same in all_scores if same and s >= t)
        fn = n_same - tp
        fp = sum(1 for s, same in all_scores if not same and s >= t)
        err = (fp / n_diff if n_diff else 0.0) + (fn / n_same if n_same else 0.0)
        if err < best_err:
            best_err = err
            best_t = t

    best_tp = sum(1 for s, same in all_scores if same and s >= best_t)
    best_fn = n_same - best_tp
    best_fp = sum(1 for s, same in all_scores if not same and s >= best_t)
    best_tn = n_diff - best_fp
    best_acc = (best_tp + best_tn) / n_trials

    print(f"\n{'─'*55}")
    print(f"Optimal threshold (minimises FP rate + FN rate): {best_t:.6f}")
    print(f"  FP rate  : {best_fp / n_diff if n_diff else 0:.3f}  ({best_fp}/{n_diff})")
    print(f"  FN rate  : {best_fn / n_same if n_same else 0:.3f}  ({best_fn}/{n_same})")
    print(f"  Accuracy : {best_acc:.3f}")

    return best_t


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Evaluate language_similarity.py on the eBible corpus.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument(
        "--source",
        choices=["huggingface", "ebible-dir", "synthetic"],
        default=None,
        help=(
            "Data source: 'huggingface' downloads from HuggingFace (requires "
            "the datasets package); 'ebible-dir' loads from a local eBible "
            "corpus directory (see --ebible-dir); 'synthetic' uses built-in "
            "multilingual samples (no network or extra packages required). "
            "Defaults to 'ebible-dir' when --ebible-dir is given, otherwise "
            "'huggingface'."
        ),
    )
    p.add_argument(
        "--ebible-dir",
        default=None,
        metavar="PATH",
        help=(
            "Path to the eBible 'corpus/' directory.  Clone "
            "https://github.com/BibleNLP/ebible and pass the path to its "
            "corpus/ sub-directory.  Passing this option implicitly sets "
            "--source ebible-dir unless --source is given explicitly."
        ),
    )
    p.add_argument("--trials", type=int, default=1000,
                   help="Number of test pairs")
    p.add_argument("--corpus-size", type=int, default=50,
                   help="Verses/sentences per mini-corpus")
    p.add_argument("--threshold", type=float, default=0.5,
                   help="Similarity decision threshold")
    p.add_argument("--min-verses", type=int, default=200,
                   help="Minimum verses a language must have to be included")
    p.add_argument("--max-languages", type=int, default=None,
                   help="Randomly subsample this many languages (None = all)")
    p.add_argument("--seed", type=int, default=42,
                   help="Random seed")
    p.add_argument("--no-sweep", action="store_true",
                   help="Skip optimal-threshold sweep (faster)")
    return p.parse_args()


if __name__ == "__main__":
    args = _parse_args()

    # Infer source when not given explicitly: presence of --ebible-dir implies
    # the user wants to load from a local directory, not HuggingFace.
    source = args.source
    if source is None:
        source = "ebible-dir" if args.ebible_dir is not None else "huggingface"

    if source == "huggingface":
        by_lang = load_from_huggingface(
            min_verses=args.min_verses,
            max_languages=args.max_languages,
        )
    elif source == "ebible-dir":
        ebible_dir = args.ebible_dir if args.ebible_dir is not None else "corpus"
        by_lang = load_from_ebible_dir(
            ebible_dir,
            min_verses=args.min_verses,
            max_languages=args.max_languages,
        )
    else:  # synthetic
        by_lang = load_synthetic(
            min_verses=5,
            max_languages=args.max_languages,
        )

    evaluate(
        by_lang,
        n_trials=args.trials,
        corpus_size=args.corpus_size,
        threshold=args.threshold,
        seed=args.seed,
        sweep_thresholds=not args.no_sweep,
    )
