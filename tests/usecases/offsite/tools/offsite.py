"""Trusted tool of Acme's offsite mission. One file with modes (a tool runs alone in its sandbox and cannot import
another file of the mission). Input JSON on stdin; the mission's data (the run's vault) is in AGENCY_DATA.

Nothing here comes from a model. Messages are built from fixed templates and never name answers or counts:
an invitation, a reminder and the final details carry only the date, the venue and the time.

modes
  invitation / reminder   the text for one team                              -> {team, event, body}
  count                   item "rsvp:<team>", quorum (percent): the team counts once at least ceil(quorum % of its
                          roster) members answered (yes or no). Then an item_resolved "counted"; otherwise a wall
                          precondition_missing naming the reminder round: number_in_range late:<team> >= missing
  measure                 quantity "late:<team>": how many members of the team answered the reminder round
  venue_request           the request to one venue                          -> {venue, event, body}
  venue_check             the venue's own answer in the vault: free, priced, within the cap and a supplier of ours
                          -> {item, supplier, amount, event, venue}; anything else is a wall
  catering                the confirmed headcount (yes answers of every team) times the caterer's price per person;
                          a price per person over the cap, or no headcount, is a wall
  details                 the final details for one team: date, venue (the one venue that confirmed) and time
"""
import csv
import json
import os
import sys

request = json.load(sys.stdin)
DATA = os.environ.get("AGENCY_DATA", "/data")


def rows(name):
    path = os.path.join(DATA, name)
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def out(value, **extra):
    print(json.dumps({"value": value, **extra}))
    sys.exit(0)


def wall(reason, cause="move_failed", **extra):
    out(None, wall={"cause": cause, "reason": reason[:300], **extra})


def subject(item):
    return str(item or "").partition(":")[2]


def roster(team):
    return [row for row in rows("roster.csv") if row["team"] == team]


def answered(team, round_=None):
    """The members of the team whose answer is in the vault (one row per respondent; a later answer replaces one)."""
    members = {row["id"] for row in roster(team)}
    seen = {}
    for row in rows("rsvp.csv"):
        if row["team"] == team and row["respondent"] in members and row["answer"] in ("yes", "no"):
            if round_ is None or row["round"] == round_:
                seen[row["respondent"]] = row["answer"]
    return seen


def supplier(ref, kind):
    return next((row for row in rows("suppliers.csv") if row["supplier"] == ref and row["kind"] == kind), None)


mode = request.get("mode")
event = str(request.get("event") or "")

if mode in ("invitation", "reminder"):
    team = str(request.get("team") or "")
    if not roster(team):
        wall(f"{team[:30]} is no team of the roster")
    date = request.get("date", "")
    if mode == "invitation":
        body = (f"Dear colleagues of the {team} team,\n\nyou are invited to the Acme company offsite on {date}, "
                f"{request.get('time', '')}. Please answer this message with yes or no, so that we can plan "
                "the venue and the catering.\n\nKind regards\nThe office manager")
    else:
        body = (f"Dear colleagues of the {team} team,\n\na friendly reminder: the invitation to the Acme company offsite "
                f"on {date} is still open. If you have not answered yet, please reply with yes or no.\n\n"
                "Kind regards\nThe office manager")
    out({"team": team, "event": event, "body": body})

if mode == "count":
    item = str(request.get("item") or "")
    team = subject(item)
    members = roster(team)
    if not members:
        wall(f"{team[:30]} is no team of the roster")
    quorum = int(request.get("quorum") or 60)
    needed = -(-len(members) * quorum // 100)
    have = len(answered(team))
    if have >= needed:
        out({"item": item, "outcome": "counted"})
    out({"team": team, "answered": have, "needed": needed}, wall={
        "cause": "precondition_missing",
        "reason": f"{have} of {len(members)} members of {team} answered, {needed} are needed",
        "precondition": {"id": f"reminder-{team}", "type": "number_in_range",
                         "values": {"quantity": f"late:{team}", "min": needed - have}},
    })

if mode == "measure":
    quantity = str(request.get("quantity") or "")
    out({"quantity": quantity, "value": len(answered(subject(quantity), "reminder"))})

if mode == "venue_request":
    venue = supplier(str(request.get("venue") or ""), "venue")
    if venue is None:
        wall("the venue is not on our supplier list")
    body = (f"Dear events team of {venue['name']},\n\nwe would like to hold a company offsite for up to 25 people "
            f"on {request.get('date', '')}, from 09:30 to 17:00. Could you let us know whether the day is free and "
            "what it costs?\n\nKind regards\nThe office manager of Acme")
    out({"venue": venue["supplier"], "event": event, "body": body})

if mode == "venue_check":
    ref = str(request.get("venue") or "")
    if supplier(ref, "venue") is None:
        wall(f"{ref[:30]} is not on our supplier list")
    answer = next((row for row in rows("venue_answers.csv") if row["venue"] == ref), None)
    if answer is None:
        wall(f"{ref} has not answered")
    if answer["available"] != "yes":
        wall(f"{ref} declined the date")
    try:
        price = float(answer["price"])
    except ValueError:
        wall(f"{ref} named no price")
    cap = float(request.get("cap") or 0)
    if not 0 < price <= cap:
        wall(f"{ref} costs {price:.2f} EUR, the cap is {cap:.2f} EUR")
    # The supplier is ours (the plan named it, our supplier list holds it); the amount is the venue's own claim.
    out({"item": str(request.get("item") or ""), "supplier": ref, "amount": price, "event": event, "venue": ref},
        fieldLabels={"item": ["own"], "supplier": ["own"], "event": ["own"], "venue": ["own"], "amount": ["foreign"]})

if mode == "catering":
    ref = str(request.get("supplier") or "")
    caterer = supplier(ref, "caterer")
    if caterer is None:
        wall(f"{ref[:30]} is not on our supplier list")
    per_person = float(caterer["perPerson"])
    cap = float(request.get("cap") or 0)
    if per_person > cap:
        wall(f"{ref} charges {per_person:.2f} EUR per person, the cap is {cap:.2f} EUR")
    teams = sorted({row["team"] for row in rows("roster.csv")})
    headcount = sum(1 for team in teams for answer in answered(team).values() if answer == "yes")
    if headcount < 1:
        wall("no confirmed headcount")
    out({"item": str(request.get("item") or ""), "supplier": ref, "amount": round(headcount * per_person, 2),
         "perPerson": per_person, "headcount": headcount, "event": event})

if mode == "details":
    item = str(request.get("item") or "")
    team = subject(item)
    if not roster(team):
        wall(f"{team[:30]} is no team of the roster")
    free = [row["venue"] for row in rows("venue_answers.csv") if row["available"] == "yes"]
    if len(free) != 1:
        wall(f"{len(free)} venues confirmed the date; the details need exactly one")
    venue = supplier(free[0], "venue")
    body = (f"Dear colleagues of the {team} team,\n\nhere are the details of the Acme company offsite: "
            f"{request.get('date', '')}, {request.get('time', '')}, at {venue['name']}. We look forward to seeing you.\n\n"
            "Kind regards\nThe office manager")
    out({"item": item, "team": team, "event": event, "venue": venue["supplier"], "body": body})

wall("unknown mode")
