"""Stateful live proof of the multi-item merge/restore/trash workflow.

Every mutation is the same ``POST /write`` operation and the workflow must keep
several independent handles alive at once (source item, target item, collection,
note, tags), which OpenAPI Links cannot express. So the workflow is written out
here: it drives real ``Case`` objects built from the canonical operation,
validates each request body against the resolved OpenAPI component
(``contract.validate_write_body``), lets ``call_and_validate`` check
status/content-type/response-schema, and then independently verifies Zotero's
state through the built-in read-only local API. A write response reporting
success is not accepted as proof; the read-back is.

What Hypothesis explores and shrinks here is the *data*: item titles and tag
names are drawn from ``_LABEL`` and replayed across several scenarios, so a
value-dependent failure shrinks to a minimal reproducing title or tag. This is
not decoration — it is what caught Zotero's NFC normalization of stored text
(see ``helpers.nfc``), which a hard-coded ASCII title cannot reach.

The step *order* is fixed, so it is expressed as a function rather than as a
Hypothesis ``RuleBasedStateMachine``. A machine of 11 ``@precondition``-gated
rules admits exactly one legal sequence, and Hypothesis must then rediscover it
by rejection-sampling ``sampled_from(11 rules).filter(enabled)`` at every step:
measured against this workflow it aborted 86% of scenarios as invalid (5 usable
out of 37) and tripped the ``filter_too_much`` health check, which is real
wasted mutation against a real library. ``RuleBasedStateMachine`` earns its cost
when the *ordering* is what needs exploring; here only the data does.

The suite mutates a real Zotero library, so every object is uniquely prefixed
and cleaned up in a ``finally`` even on failure. Dangerous/networked/bulk
operations are never exercised here. Scenarios are serialized because they share
one Zotero process.
"""

from __future__ import annotations

import uuid
from typing import Any

import schemathesis
from hypothesis import example, given, settings
from hypothesis import strategies as st

from tests.schemathesis import contract, helpers


_SCHEMA = schemathesis.openapi.from_path(
    str(contract._SPEC_PATH)  # single source of truth
)
_WRITE = _SCHEMA["/write"]["POST"]

# Titles and tag names are drawn, not hard-coded: they are the material
# Hypothesis explores and shrinks. Whitespace is excluded from the alphabet
# rather than filtered out afterwards, so generation never rejects: leading and
# trailing whitespace would only test Zotero's trimming, which is a separate
# contract question from the storage this workflow proves. Surrogates and
# control characters are excluded as not representable in a JSON body.
_LABEL = st.text(
    alphabet=st.characters(blacklist_categories=("Cs", "Cc", "Zs", "Zl", "Zp")),
    min_size=1,
    max_size=40,
)

# Labels whose NFC form differs from the input, each a different way NFC can
# change text. Written as escapes, never as precomposed literals: an editor or a
# paste can silently normalize a literal, which would turn these into ordinary
# NFC text and quietly retire the very case they exist to pin.
_GURMUKHI_LLA = "\u0a33"  # NFC decomposes it -> U+0A32 U+0A3C (composition exclusion)
_E_ACUTE_DECOMPOSED = "e\u0301"  # NFC composes it -> U+00E9
_ANGSTROM_SIGN = "\u212b"  # NFC maps it -> U+00C5 (singleton)

# An already-NFC label would make its example vacuous: the round-trip would pass
# whether or not Zotero normalizes. Fail at import rather than pass for free.
for _label in (_GURMUKHI_LLA, _E_ACUTE_DECOMPOSED, _ANGSTROM_SIGN):
    assert helpers.nfc(_label) != _label, (
        f"pinned example {_label!r} is already NFC and would prove nothing"
    )


def _send(body: dict[str, Any]) -> dict[str, Any]:
    """Validate the body against the contract, send it, and let Schemathesis
    validate the response, then return the parsed JSON."""
    contract.validate_write_body(body)
    case = _WRITE.Case(body=body, media_type="application/json")
    # A generous timeout: the single Zotero process can be slow under a
    # back-to-back workflow, and a read timeout would surface to Hypothesis as
    # spurious flakiness rather than a contract failure.
    response = case.call_and_validate(base_url=helpers.base_url(), timeout=60)
    payload = response.json()
    assert payload.get("success") is True, f"write not successful: {payload!r}"
    return payload


# max_examples is the number of independent scenarios, each replaying the full
# workflow against the single Zotero process with freshly drawn titles and tags.
# It is deliberately small: every example is real live mutation, so raising it
# trades run time for exploration depth rather than being free.
# deadline=None because a live Zotero's latency is not a contract failure.
@settings(max_examples=5, deadline=None)
@given(
    token=st.uuids(version=4),
    source_label=_LABEL,
    target_label=_LABEL,
    keep_label=_LABEL,
    remove_label=_LABEL,
)
# Random draws reach normalization-sensitive characters only by luck: a
# 5-example run routinely draws none, and measured here a byte-identity
# assertion still passed a full run. So the NFC contract is pinned explicitly on
# both a title and a tag rather than left to generation, which covers the forms
# not listed. The fixed token is deliberate: these objects are trashed in the
# finally like any other, and a stable prefix keeps repeat runs identifiable.
@example(
    token=uuid.UUID("00000000-0000-4000-8000-000000000000"),
    source_label=_GURMUKHI_LLA,
    target_label=_E_ACUTE_DECOMPOSED,
    keep_label=_ANGSTROM_SIGN,
    remove_label=_E_ACUTE_DECOMPOSED,
)
def test_write_workflow(
    token, source_label, target_label, keep_label, remove_label
) -> None:
    # Every value is drawn by Hypothesis (not uuid4/literals) so scenarios are
    # deterministic and replayable during shrinking. The ``lw-*-{uid}`` prefix
    # keeps objects identifiable and unique against a real library; the drawn
    # suffix is the part actually explored. The keep/remove tags stay distinct
    # regardless of what is drawn.
    uid = token.hex[:12]
    source_title = f"lw-source-{uid}-{source_label}"
    target_title = f"lw-target-{uid}-{target_label}"
    keep_tag = f"lw-keep-{uid}-{keep_label}"
    remove_tag = f"lw-remove-{uid}-{remove_label}"

    collection_key: str | None = None
    source_key: str | None = None
    target_key: str | None = None

    try:
        # ── create the collection ────────────────────────────────
        payload = _send({"operation": "create_collection", "name": f"lw-col-{uid}"})
        collection_key = payload["details"]["collection_key"]
        assert collection_key

        # ── create the source item ───────────────────────────────
        payload = _send(
            {
                "operation": "create_item",
                "item_type": "book",
                "fields": {"title": source_title},
            }
        )
        source_key = payload["item_key"]
        assert source_key
        # NFC, not the sent bytes: Zotero normalizes stored text (helpers.nfc).
        assert helpers.get_item(source_key)["data"]["title"] == helpers.nfc(source_title)

        # ── attach a note ────────────────────────────────────────
        payload = _send(
            {
                "operation": "attach_note",
                "parent_item_key": source_key,
                "note_text": f"note-{uid}",
            }
        )
        note_key = payload["note_key"]
        assert note_key
        children = helpers.get_children(source_key)
        assert any(child.get("key") == note_key for child in children), (
            f"note {note_key} not a child of source: {children!r}"
        )

        # ── assign it to the collection ──────────────────────────
        _send(
            {
                "operation": "add_item_to_collection",
                "item_key": source_key,
                "collection_key": collection_key,
            }
        )
        collections = helpers.get_item(source_key)["data"].get("collections", [])
        assert collection_key in collections, f"source not in collection: {collections!r}"

        # ── add both tags ────────────────────────────────────────
        _send(
            {
                "operation": "add_item_tags",
                "item_key": source_key,
                "tags": [keep_tag, remove_tag],
            }
        )
        # helpers.tag_names returns NFC forms, so compare against NFC(sent).
        tags = helpers.tag_names(helpers.get_item(source_key))
        assert {helpers.nfc(keep_tag), helpers.nfc(remove_tag)} <= tags, (
            f"tags missing: {tags!r}"
        )

        # ── remove one tag, keep the other ───────────────────────
        _send(
            {
                "operation": "remove_item_tags",
                "item_key": source_key,
                "tags": [remove_tag],
            }
        )
        tags = helpers.tag_names(helpers.get_item(source_key))
        assert helpers.nfc(remove_tag) not in tags, f"remove tag survived: {tags!r}"
        assert helpers.nfc(keep_tag) in tags, f"keep tag lost: {tags!r}"

        # ── create the merge target ──────────────────────────────
        payload = _send(
            {
                "operation": "create_item",
                "item_type": "book",
                "fields": {"title": target_title},
            }
        )
        target_key = payload["item_key"]
        assert target_key
        assert helpers.get_item(target_key)["data"]["title"] == helpers.nfc(target_title)

        # ── merge source into target ─────────────────────────────
        payload = _send(
            {
                "operation": "merge_items",
                "source_key": source_key,
                "target_key": target_key,
            }
        )
        transferred = payload["details"]["transferred"]
        for field in ("attachments", "notes", "tags", "relations"):
            assert isinstance(
                transferred[field], int
            ), f"transfer counter {field} not int: {transferred!r}"
        assert transferred["notes"] >= 1, f"expected note transfer: {transferred!r}"

        # Zotero's trash is deferred, so the source's deleted flag is the one
        # value that must be polled (same as live_smoke's _wait_for_deleted).
        assert helpers.wait_for(
            lambda: helpers.is_deleted(source_key)
        ), "merged source not deleted"
        target = helpers.get_item(target_key)
        assert not target["data"].get("deleted"), "merge target deleted"
        target_children = helpers.get_children(target_key)
        assert any(child.get("key") == note_key for child in target_children), (
            f"note did not move under target: {target_children!r}"
        )
        assert helpers.nfc(keep_tag) in helpers.tag_names(
            target
        ), "kept tag did not transfer to target"

        # ── restore the merged source ────────────────────────────
        _send({"operation": "restore_item", "item_key": source_key})
        assert helpers.wait_for(
            lambda: not helpers.is_deleted(source_key)
        ), "restore_item did not clear deleted flag"

        # ── trash it again ───────────────────────────────────────
        _send({"operation": "trash_item", "item_key": source_key})
        assert helpers.wait_for(
            lambda: helpers.is_deleted(source_key)
        ), "trash_item did not set deleted flag"

        # ── final re-read of every retained handle ───────────────
        # Collection membership is not asserted post-merge: merge_items does not
        # transfer it in current code, so this only re-reads what must still hold.
        assert helpers.is_deleted(source_key), "final: source not trashed"
        target = helpers.get_item(target_key)
        assert not target["data"].get("deleted"), "final: target deleted"
        assert helpers.nfc(keep_tag) in helpers.tag_names(target), (
            "final: kept tag missing"
        )
    finally:
        # Trash the objects this scenario actually created. Keys are None only
        # when the scenario failed before creating that object. Trash is
        # idempotent, so re-trashing the already-trashed source is fine; if a
        # trash fails here Zotero is genuinely broken and that must surface.
        for item_key in (source_key, target_key):
            if item_key:
                helpers.trash_item(item_key)
        if collection_key:
            helpers.trash_collection(collection_key)
