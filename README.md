# Care Finder

**CMU Fall 2026 Datathon**

Care Finder helps community health workers in India find nearby facilities for a specific healthcare service and understand why each facility was recommended. Enter a service and a six-digit Indian PIN code to compare nearby options on a ranked list and map.

## How to use Care Finder

1. **Choose a service.** Search by name or alias. The search uses a catalog of services identified in the facility dataset, including dialysis, MRI, and NICU.
2. **Enter a PIN code.** The app uses the India Post directory to estimate the search origin. If the PIN maps to multiple areas, select the intended area when prompted.
3. **Compare facilities.** Numbered map pins correspond to the ranked results. Each card shows the branch, approximate straight-line distance, and the main reason for its rank.
4. **View the evidence.** Open **View evidence** to see the original facility text, external sources when reviewed, and the score breakdown. Confirm current availability with the facility before referral.

A facility with an equipment or list-only mention can appear under **Leads to check**. If no eligible facilities are found, the app reports that it found insufficient evidence for the selected service within the search radius.

## Data sources

| Source | How it is used |
| --- | --- |
| Virtue Foundation Dataset (DAIS 2026) | Facility names, branch locations, coordinates, service text, and source URLs |
| India Post PIN Code Directory | Approximate search origin and postal geography |
| Team-reviewed external evidence | Branch and service claims checked against sources such as official facility websites and government listings |

The Marketplace tables are `facilities` and `india_post_pincode_directory` in the `databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset` schema.

The postal directory is published through [India’s Open Government Data Platform](https://www.data.gov.in/resource/all-india-pincode-directory-till-last-month) under the [Government Open Data License – India](https://www.data.gov.in/Godl).

## Data cleaning and validation

The cleaning workflow preserves original values and links derived records to the original facility using `unique_id`. It checks coordinate bounds and consistency, groups postal records by PIN before joining to avoid duplicate results, and flags conflicting locations, potential duplicates, and suspected merged branches. Agreement between the coordinate fields is an internal consistency check. A branch’s location is reviewed separately.

The service catalog is built from the `description`, `procedure`, `capability`, and `equipment` fields. It groups spelling variants and clear synonyms while preserving distinct services. Every match retains the original text and field so users can see whether the record explicitly says the branch provides the service or only mentions it.

External evidence is tracked for each facility and service pair. A review records the source URL, exact excerpt, review date, and whether the source supports or conflicts with the claim. An address page can support the branch location. A service claim needs text that ties the service to that branch. Multiple copies of the same source count once.

## Evidence score and ranking

| Component | Max points | Scoring rule |
| --- | ---: | --- |
| Service evidence | 50 | 50 for a reviewed official or government source that explicitly ties the service to the branch, 30 for an explicit dataset claim awaiting external review, 10 for a list or equipment mention, and 0 for unsupported or negated claims or claims about another branch |
| Branch identity and location | 30 | 30 for a reviewed branch and address with usable coordinates, 15 for consistent dataset and postal fields awaiting review, and 0 for missing coordinates or an unresolved conflict |
| Independent corroboration | 20 | 20 when a second independent reviewed source explicitly supports the same service at the same branch |

The evidence score summarizes the strength of the documented evidence. Current availability can change after a source is published or reviewed.

Within the default **50 km** radius, eligible facilities are ranked by evidence score, then by shorter distance, then by facility ID for stable ties. Eligibility requires an explicit service claim, usable coordinates, and no unresolved branch, location, or service conflict. The app shows up to three ranked results.

## Databricks setup

1. Open the team’s Databricks Free Edition workspace and make the Virtue Foundation Marketplace dataset available in Unity Catalog.
2. Open the team’s **Cleaning** notebook and run the cleaning and location-audit steps. Use the team’s published outputs or publish them to a writable project schema.
3. Configure the Care Finder app with the SQL warehouse and project data objects it queries. Grant the app read access and restrict evidence-review writes to authorized reviewers.
4. Open the app and test a real PIN and service. Compare the ranked list, map pins, and evidence excerpts with the query output.

## Demo checks

- Search by a service alias and confirm that the app selects the expected service.
- Click a map pin and trace the corresponding card’s score to its source evidence.
- Compare a closer facility with weaker support against a farther facility with stronger support.
- Verify that an unresolved branch conflict keeps a facility out of the ranked results.
- Try a PIN with multiple post-office records and check that results are deduplicated.
- Run a search with insufficient evidence and check that the message explains the outcome.
