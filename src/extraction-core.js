(() => {
  "use strict";

  const MONTHS = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
    apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
    aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9,
    october: 9, nov: 10, november: 10, dec: 11, december: 11
  };

  const NOISE_EXACT = new Set([
    "message", "follow", "connect", "more", "… more", "... more", "contact info", "show all", "see more",
    "show less", "notifications", "connections", "mutual connections", "is online",
    "pending", "save", "saved", "home", "my network", "jobs", "messaging", "open to",
    "visit website", "send profile in a message", "report or block", "remove connection",
    "view profile", "view full profile", "people also viewed", "people you may know", "highlights"
  ]);

  const EMPLOYMENT_TYPE_PATTERN = /^(?:full[- ]time|part[- ]time|self-employed|freelance|contract|internship|apprenticeship|seasonal|temporary)$/i;
  const DURATION_PATTERN = /^\d+\s+(?:yr|yrs|year|years|mo|mos|month|months)(?:\s+\d+\s+(?:mo|mos|month|months))?$/i;
  const WORK_MODE_PATTERN = /^(?:remote|hybrid|on[- ]site|onsite)$/i;

  // ------------------------------------------------------- field boundaries
  // LinkedIn paints a role's metadata as sibling spans, and its innerText
  // collapses them into one line whenever the separator span does not render.
  // That is how "TechMatrix Consulting · Full-time" and "9 mos" arrive as
  // "TechMatrix Consulting 9 mos" and end up saved as a role title or a company
  // named "Full-time". These patterns peel that metadata off the END of a value
  // only, so a genuine name containing one of the words survives.

  const TRAILING_DURATION_PATTERN = /[\s·•,]*\b\d+\s+(?:yrs?|years?|mos?|months?)(?:\s+\d+\s+(?:mos?|months?))?\s*$/i;
  const TRAILING_EMPLOYMENT_PATTERN = /[\s·•,]*[·•]\s*(?:full[- ]time|part[- ]time|self-employed|freelance|contract|internship|apprenticeship|seasonal|temporary)\s*$/i;
  const TRAILING_MODE_PATTERN = /[\s·•,]*[·•]\s*(?:remote|hybrid|on[- ]site|onsite)\s*$/i;

  /** Controls and endorsement chrome that LinkedIn renders inside a skill card. */
  const SKILL_CONTROL_PATTERN =
    /\b(?:endorse|endorsed|endorsement|endorsements|remove endorsement|add skill|show all|see all|see more|show more|associated with|\d+\s+endorsements?)\b/i;

  const ROLE_WORD_PATTERN =
    /\b(?:engineer|developer|manager|consultant|analyst|designer|intern|associate|specialist|officer|lead|director|architect|founder|president|head)\b/i;

  /** Strip trailing duration / employment type / work mode from a value. */
  function stripEntityMeta(value) {
    let text = collapseRepeatedText(value);
    let previous = "";
    while (text && text !== previous) {
      previous = text;
      text = text
        .replace(TRAILING_DURATION_PATTERN, "")
        .replace(TRAILING_EMPLOYMENT_PATTERN, "")
        .replace(TRAILING_MODE_PATTERN, "")
        .replace(/[·•,\s]+$/, "")
        .trim();
    }
    return cleanText(text);
  }

  /** True for a value that is employment metadata rather than a name. */
  function isEmploymentMeta(value) {
    const text = cleanText(value);
    if (!text) return false;
    return EMPLOYMENT_TYPE_PATTERN.test(text) || DURATION_PATTERN.test(text) ||
      WORK_MODE_PATTERN.test(text) || looksLikeDateRange(text);
  }

  /**
   * Reduce a value to an organization name, or "" when it is not one.
   * "Full-time", "9 mos", "Remote", and date ranges are never companies.
   */
  function sanitizeCompanyName(value) {
    const raw = collapseRepeatedText(value);
    if (!raw) return "";
    const parts = raw
      .split(/\s*[·•]\s*/)
      .map((part) => stripEntityMeta(part))
      .filter((part) => part && !isEmploymentMeta(part));
    const text = stripEntityMeta(parts.join(" · "));
    if (!text || isEmploymentMeta(text)) return "";
    if (SKILL_CONTROL_PATTERN.test(text) && text.split(/\s+/).length <= 3) return "";
    return text;
  }

  /**
   * Reduce a value to a role title, or "" when it is not one.
   * Employment metadata is stripped, a trailing "at <company>" is removed, and a
   * "title" that is really the company is rejected rather than guessed at.
   */
  function sanitizeRoleTitle(value, company = "") {
    let text = stripEntityMeta(value);
    if (!text) return "";
    const companyKey = normalizeCompanyName(company);
    const atMatch = /^(.{2,120}?)\s+(?:at|@)\s+(.{2,120})$/i.exec(text);
    if (atMatch) {
      const tail = normalizeCompanyName(atMatch[2]);
      const matchesCompany = Boolean(companyKey) &&
        (tail === companyKey || tail.startsWith(companyKey) || companyKey.startsWith(tail));
      if (matchesCompany) text = stripEntityMeta(atMatch[1]);
    }
    if (!text || isEmploymentMeta(text)) return "";
    if (companyKey && normalizeCompanyName(text) === companyKey) return "";
    return text;
  }

  /**
   * True for something that is genuinely a skill.
   *
   * A skill card's container text carries the endorsement button and the role the
   * skill was used in, so "Endorse" and "Associate Software Engineer at
   * TechMatrix Consulting Endorse" both reach here and must both be refused.
   */
  function isSkillValue(value) {
    const text = collapseRepeatedText(typeof value === "string" ? value : value?.name);
    if (!text || text.length > 100) return false;
    if (isNoiseText(text)) return false;
    if (SKILL_CONTROL_PATTERN.test(text)) return false;
    if (isEmploymentMeta(text)) return false;
    // A count, not a name: an endorsement tally, a follower count, a year.
    if (/^[\d,.\s+]+$/.test(text)) return false;
    // A section heading swept up by the fallback read of a section with no
    // entity blocks. "Interests" is the block that renders other members.
    if (SECTION_LABEL_PATTERN.test(text)) return false;
    // A role sentence, not a skill.
    if (/\b(?:at|@)\b/i.test(text) && ROLE_WORD_PATTERN.test(text)) return false;
    if (text.split(/\s+/).filter(Boolean).length > 10) return false;
    if (/[.!?]\s+\S/.test(text)) return false;
    return true;
  }

  /**
   * True for something that is genuinely an Interest.
   *
   * The Interests block renders OTHER entities — the companies, newsletters,
   * schools and groups the member follows — and each tile carries a follower
   * count and a Follow button, above a tab strip reading "Companies /
   * Newsletters / Schools". The tile's name is the interest; none of the rest is.
   */
  function isInterestValue(value) {
    const text = collapseRepeatedText(typeof value === "string" ? value : value?.name);
    if (!text || text.length > 120) return false;
    if (isNoiseText(text)) return false;
    // The block's own heading and its tab labels.
    if (SECTION_LABEL_PATTERN.test(text)) return false;
    if (/^\s*\+?\s*follow(?:ing|ers?|ed)?\s*$/i.test(text)) return false;
    // A tally rendered under the tile, not a name: "69,381 followers".
    if (/\b(?:followers?|members?|subscribers?|associate members?)\b/i.test(text)) return false;
    if (SKILL_CONTROL_PATTERN.test(text)) return false;
    if (isEmploymentMeta(text)) return false;
    if (/^[\d,.\s+]+$/.test(text)) return false;
    return true;
  }

  /** A profile section's own heading is never one of its values. */
  const SECTION_LABEL_PATTERN =
    /^(?:skills?|interests?|experiences?|educations?|languages?|certifications?|licenses? (?:&|and) certifications?|top voices|companies|groups|newsletters|schools|recommendations?|activity|about|featured|honors? (?:&|and) awards?|projects?|publications?|courses?|volunteering)$/i;
  const DEGREE_PATTERN = /\b(?:bca|mca|b\.?(?:tech|e)|m\.?(?:tech|e)|bachelor|master|mba|ph\.?d|doctor|diploma|associate|secondary|senior secondary|computer applications?|computer science|engineering|arts|science|commerce)\b/i;

  function cleanText(value) {
    return String(value ?? "")
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
      .replace(/\u00A0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function normalizeKey(value) {
    return cleanText(value).toLowerCase().replace(/[\s:]+$/g, "");
  }

  function comparisonKey(value) {
    return cleanText(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  }

  function collapseRepeatedText(value) {
    let text = cleanText(value)
      .replace(/(?:\s*[.…]{1,3}\s*more\s*)+$/i, "")
      .replace(/^(?:[.…]{1,3}\s*more\s*)+/i, "")
      .replace(/^(?:highlights?\s*:\s*)+/i, "")
      .trim();
    if (!text) return "";

    const commaParts = text.split(/\s*,\s*/).filter(Boolean);
    if (commaParts.length > 1 && commaParts.every((part) => comparisonKey(part) === comparisonKey(commaParts[0]))) {
      text = commaParts[0];
    }

    const pipeParts = text.split(/\s*[|;]\s*/).filter(Boolean);
    if (pipeParts.length > 1 && pipeParts.every((part) => comparisonKey(part) === comparisonKey(pipeParts[0]))) {
      text = pipeParts[0];
    }

    // LinkedIn renders a skill name twice — once visibly, once for screen
    // readers — and `innerText` welds the two together with no separator at all,
    // so "Docker" arrives as "DockerDocker". The doubling is only collapsed when
    // the second half starts a new word (a capital mid-string) or is long enough
    // that the repetition cannot be a coincidence, so "couscous" survives intact.
    if (text.length % 2 === 0) {
      const half = text.length / 2;
      const left = text.slice(0, half);
      const right = text.slice(half);
      const deliberate = /^[A-Z0-9]/.test(right) || half >= 6;
      if (half >= 3 && deliberate && !/\s/.test(text) && comparisonKey(left) === comparisonKey(right)) {
        text = left;
      }
    }

    const words = text.split(/\s+/).filter(Boolean);
    for (let size = Math.floor(words.length / 2); size >= 2; size -= 1) {
      if (words.length !== size * 2) continue;
      const first = words.slice(0, size).join(" ");
      const second = words.slice(size).join(" ");
      if (comparisonKey(first) === comparisonKey(second)) {
        text = first;
        break;
      }
    }
    return cleanText(text);
  }

  function isNoiseText(value) {
    const text = collapseRepeatedText(value);
    if (!text) return true;
    const lower = text.toLowerCase();
    if (NOISE_EXACT.has(lower)) return true;
    if (/^(?:\d+[,.]?\d*\s*)?(?:followers?|connections?|endorsements?|notifications?)$/i.test(text)) return true;
    if (/^[·•]?\s*[123](?:st|nd|rd)\s*$/i.test(text)) return true;
    if (/^\d{1,4}$/.test(text)) return true;
    if (/^(?:show|see) all \d+/i.test(text)) return true;
    if (/^(?:like|comment|repost|send)(?:\s+\d+)?$/i.test(text)) return true;
    return false;
  }

  function uniqueText(values) {
    const seen = new Set();
    const output = [];
    for (const raw of values || []) {
      const value = collapseRepeatedText(raw);
      const key = comparisonKey(value);
      if (!value || isNoiseText(value) || seen.has(key)) continue;
      seen.add(key);
      output.push(value);
    }
    return output;
  }

  function cleanEntityLines(values) {
    const lines = uniqueText(values)
      .map((value) => collapseRepeatedText(value.replace(/^\s*[·•]\s*/, "")))
      .filter(Boolean);

    return lines.filter((line, index) => {
      if (line.length < 100) return true;
      const key = comparisonKey(line);
      const contained = lines.filter((other, otherIndex) => {
        if (otherIndex === index || other.length < 4 || other.length >= line.length * 0.9) return false;
        const otherKey = comparisonKey(other);
        return otherKey && key.includes(otherKey);
      });
      return contained.length < 2;
    });
  }

  /**
   * The member's page, and nothing about which part of it is open.
   *
   * LinkedIn routes its sub-views into the URL — opening Contact info moves the
   * address to `/in/slug/overlay/contact-info/`, and "Show all skills" moves it
   * to `/in/slug/details/skills/`. The profile link is read after the overlay is
   * opened, so without this the record's `profileUrl` became the overlay URL:
   * a different address, a different id hash, and no match for the queue row it
   * came from. Everything after `/in/<slug>` is dropped.
   */
  function canonicalizeProfileUrl(url) {
    try {
      const parsed = new URL(url);
      parsed.hash = "";
      parsed.search = "";
      parsed.hostname = parsed.hostname.toLowerCase();
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
      if (/(?:^|\.)linkedin\.com$/i.test(parsed.hostname)) {
        const member = /^(\/in\/[^/]+)(?:\/.*)?$/i.exec(parsed.pathname);
        if (member) parsed.pathname = member[1];
      }
      return parsed.toString();
    } catch {
      return cleanText(url);
    }
  }

  function splitName(fullName) {
    const parts = cleanText(fullName).split(/\s+/).filter(Boolean);
    if (!parts.length) return { firstName: "", lastName: "" };
    if (parts.length === 1) return { firstName: parts[0], lastName: "" };
    return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
  }

  // ------------------------------------------------------- who the page is about
  //
  // Live defect: a connection was saved under the name "Aakash Educational
  // Services Limited" — a company the member follows, rendered in the Interests
  // block, not the member. Every signal the old scorer used said "this is a
  // plausible person": letters only, four words, no digits, near the top of a
  // card. What it never consulted is the one identifier on the page that no
  // re-render and no redesign can move — the member's OWN URL. LinkedIn builds
  // /in/<slug> out of the member's name and only appends digits to make it
  // unique, so the slug and the name agree by construction, and a candidate that
  // shares no word with it is somebody (or something) else. That is structure,
  // not array position (rule 7), and it holds across every LinkedIn layout.

  /** Words that make a value an organization's name rather than a person's. */
  const ORGANIZATION_NAME_PATTERN =
    /\b(?:limited|ltd|pvt|private|inc|incorporated|llc|llp|plc|gmbh|corp|corporation|company|co|institute|institutes|institution|university|college|school|schools|academy|academies|foundation|trust|group|services|solutions|technologies|technology|systems|enterprises|industries|labs|laboratories|consultancy|consultants|hospital|clinic|bank|society|association|council|ventures|holdings|partners|networks|studios|educational|education|international|global|pharmaceuticals|infotech|softech|software)\b/i;

  /**
   * True for a value that names an organization.
   * Used to refuse one as a member's name — a company card, a school card and an
   * Interests tile all render a bare organization name exactly like a person's.
   */
  function looksLikeOrganizationName(value) {
    const text = cleanText(value);
    if (!text) return false;
    if (/[&@]|\bpvt\.|\bltd\./i.test(text)) return true;
    return ORGANIZATION_NAME_PATTERN.test(text);
  }

  /** Lowercase, accent-free, so "Nihál" and the slug's "nihal" compare equal. */
  function asciiFold(value) {
    // Decompose, then drop every combining mark: `\p{M}` names the category
    // rather than a code-point range, so the rule reads as what it is.
    return cleanText(value).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  }

  /** The letter-only words of a name. A script with no latin form yields none. */
  function nameWordTokens(value) {
    return asciiFold(value).split(/[^a-z]+/).filter((token) => token.length > 1);
  }

  /**
   * The words LinkedIn built a profile URL out of.
   *
   * `/in/isha-sharma-264954380` → ["isha", "sharma"]: the numeric uniquifier
   * splits away on its own because the split is on everything that is not a
   * letter. An opaque member URN (`/in/ACoAAB...`) names nobody and yields none.
   */
  function profileSlugTokens(url) {
    const match = /\/in\/([^/?#]+)/i.exec(cleanText(url));
    if (!match) return [];
    let slug = match[1];
    try { slug = decodeURIComponent(slug); } catch { /* keep the raw slug */ }
    if (/^ACoA/.test(slug)) return [];
    return asciiFold(slug).split(/[^a-z]+/).filter((token) => token.length > 1);
  }

  /**
   * How well a candidate name agrees with the profile's own URL.
   *
   * "exact"    — every word of the name is in the slug, or the two run together
   *              ("nihalsharma-1a2b" is still Nihal Sharma).
   * "partial"  — some words agree; a middle name or a suffix the slug dropped.
   * "conflict" — the slug names somebody, and this candidate is not them.
   * "unknown"  — no slug words, or a name with no latin form to compare. No
   *              opinion is offered rather than a wrong one (rule 1).
   */
  function nameSlugAgreement(name, url) {
    const slugTokens = profileSlugTokens(url);
    const tokens = nameWordTokens(name);
    if (!slugTokens.length || !tokens.length) return "unknown";
    const joinedSlug = slugTokens.join("");
    const joinedName = tokens.join("");
    if (joinedSlug.includes(joinedName) || joinedName.includes(joinedSlug)) return "exact";
    const matched = tokens.filter((token) => joinedSlug.includes(token)).length;
    if (matched === tokens.length) return "exact";
    if (matched > 0) return "partial";
    return "conflict";
  }

  function looksLikeDateRange(value) {
    const text = cleanText(value);
    return /(?:present|current|\b(?:19|20)\d{2}\b).*(?:–|—|-|\bto\b)|(?:–|—|-|\bto\b).*(?:present|current|\b(?:19|20)\d{2}\b)/i.test(text);
  }

  function isEmploymentType(value) {
    return EMPLOYMENT_TYPE_PATTERN.test(cleanText(value));
  }

  function splitCompanyEmployment(value) {
    const parts = cleanText(value).split(/\s*[·•]\s*/).map(collapseRepeatedText).filter(Boolean);
    const employmentType = parts.find(isEmploymentType) || "";
    const companyParts = parts.filter((part) => part !== employmentType && !DURATION_PATTERN.test(part));
    return { company: collapseRepeatedText(companyParts.join(" · ")), employmentType };
  }

  function looksLikeLocation(value) {
    const text = cleanText(value);
    if (!text || text.length > 140 || looksLikeDateRange(text)) return false;
    if (/\b(?:developer|engineer|manager|student|founder|co-?founder|consultant|designer|analyst|recruiter|specialist|officer|lead|director|head|chief|advisor|board|product|marketing|sales|operations)\b/i.test(text)) return false;
    if (/\b(?:remote|hybrid|on-site|onsite)\b/i.test(text)) return true;
    if (/\b(?:india|united states|united kingdom|canada|australia|singapore|uae|germany|france|japan|delhi|mumbai|jaipur|bengaluru|bangalore|hyderabad|pune|chennai|kolkata|noida|gurugram|gurgaon)\b/i.test(text)) return true;
    if (text.includes(",")) {
      const parts = text.split(",").map((part) => part.trim()).filter(Boolean);
      return parts.length >= 2 && parts.length <= 4 && parts.every((part) => part.length <= 45 && /^[\p{L} .'-]+$/u.test(part));
    }
    return false;
  }

  function splitDateDetails(value) {
    const parts = cleanText(value).split(/\s*[·•]\s*/).map(collapseRepeatedText).filter(Boolean);
    const dateRange = parts.find(looksLikeDateRange) || cleanText(value);
    const duration = parts.find((part) => DURATION_PATTERN.test(part)) || "";
    return { dateRange, duration };
  }

  function splitLocationDetails(value) {
    const parts = cleanText(value).split(/\s*[·•]\s*/).map(collapseRepeatedText).filter(Boolean);
    const workMode = parts.find((part) => WORK_MODE_PATTERN.test(part)) || "";
    const location = parts.find((part) => part !== workMode && looksLikeLocation(part)) || "";
    return { location, workMode };
  }

  function isSkillSummary(value) {
    return /(?:\band\s+\+?\d+\s+skills?\b|\+\d+\s+skills?\b|\bskills?\s*$)/i.test(cleanText(value));
  }

  function dedupeDescriptionLines(values, record = {}) {
    const blocked = new Set([record.title, record.company, record.employmentType, record.dateRange, record.duration, record.location, record.workMode]
      .map(comparisonKey).filter(Boolean));
    const lines = cleanEntityLines(values)
      .map((line) => collapseRepeatedText(line.replace(/^(?:highlights?\s*:\s*)+/i, "")))
      .filter((line) => line && !blocked.has(comparisonKey(line)))
      .filter((line) => !isSkillSummary(line) && !DURATION_PATTERN.test(line) && !looksLikeDateRange(line))
      .filter((line) => !WORK_MODE_PATTERN.test(line));

    const kept = [];
    for (const line of lines) {
      const key = comparisonKey(line);
      if (!key) continue;
      const duplicate = kept.some((existing) => {
        const existingKey = comparisonKey(existing);
        return existingKey === key || (key.length > 45 && existingKey.includes(key)) || (existingKey.length > 45 && key.includes(existingKey));
      });
      if (!duplicate) kept.push(line);
    }
    return kept;
  }

  function parseExperienceLines(inputLines, defaultCompany = "", defaultCompanyUrl = "") {
    const lines = cleanEntityLines(inputLines).filter((line) => !/^experience$/i.test(line));
    if (!lines.length) return null;
    const dateIndex = lines.findIndex(looksLikeDateRange);
    if (dateIndex < 0) return null;

    const dateDetails = splitDateDetails(lines[dateIndex]);
    const beforeDate = lines.slice(0, dateIndex)
      .filter((line) => !DURATION_PATTERN.test(line) && !looksLikeLocation(line));
    const afterDate = lines.slice(dateIndex + 1);

    let company = collapseRepeatedText(defaultCompany);
    let employmentType = "";
    let companyLine = "";
    for (const line of beforeDate) {
      const parsed = splitCompanyEmployment(line);
      if (parsed.employmentType) {
        employmentType ||= parsed.employmentType;
        if (parsed.company) companyLine ||= parsed.company;
      }
    }

    if (!company && companyLine) company = companyLine;
    const titleCandidates = beforeDate.filter((line) => {
      const key = comparisonKey(line);
      if (!key || key === comparisonKey(company) || key === comparisonKey(companyLine)) return false;
      const parsed = splitCompanyEmployment(line);
      if (parsed.employmentType && !parsed.company) return false;
      return !isEmploymentType(line) && !DURATION_PATTERN.test(line);
    });

    let title = titleCandidates[0] || "";
    if (!company) {
      const nonTitle = beforeDate.find((line) => comparisonKey(line) !== comparisonKey(title));
      if (nonTitle) {
        const parsed = splitCompanyEmployment(nonTitle);
        company = parsed.company || nonTitle;
        employmentType ||= parsed.employmentType;
      }
    }

    if (defaultCompany && titleCandidates.length > 1) {
      title = titleCandidates.find((line) => comparisonKey(line) !== comparisonKey(defaultCompany)) || title;
    }

    const locationLine = afterDate.find((line) => looksLikeLocation(line) || WORK_MODE_PATTERN.test(line)) || "";
    const locationDetails = splitLocationDetails(locationLine);
    // The company is resolved first so the title can be checked against it: a
    // "title" that is really the company, or carries its duration, is not a title.
    const cleanCompany = sanitizeCompanyName(company);
    const record = {
      title: sanitizeRoleTitle(title, cleanCompany),
      company: cleanCompany,
      companyUrl: canonicalizeProfileUrl(defaultCompanyUrl),
      employmentType: collapseRepeatedText(employmentType),
      dateRange: dateDetails.dateRange,
      duration: dateDetails.duration,
      location: locationDetails.location,
      workMode: locationDetails.workMode,
      description: "",
      isCurrent: /\b(?:present|current)\b/i.test(dateDetails.dateRange)
    };
    record.description = dedupeDescriptionLines(afterDate.filter((line) => line !== locationLine), record).join(" • ");
    return record;
  }

  function formatExperience(record) {
    if (!record) return "";
    const fields = [
      ["Title", record.title],
      ["Company", record.company],
      ["Type", record.employmentType],
      ["Dates", record.dateRange],
      ["Duration", record.duration],
      ["Location", record.location],
      ["Mode", record.workMode],
      ["Description", record.description]
    ];
    return fields.filter(([, value]) => cleanText(value)).map(([label, value]) => `${label}: ${collapseRepeatedText(value)}`).join(" | ");
  }


  const EXPERIENCE_ROLE_SEPARATOR = " ⟪ROLE⟫ ";
  const EXPERIENCE_FIELD_LABELS = ["Title", "Company", "Company URL", "Company Image", "Type", "Dates", "Duration", "Location", "Mode", "Description"];

  function parseLabeledFields(value, labels = EXPERIENCE_FIELD_LABELS) {
    const text = cleanText(value);
    const allowed = new Set(labels);
    const labelPattern = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const regex = new RegExp(`(?:^|\\s+\\|\\s+)(${labelPattern}):\\s*`, "g");
    const matches = [...text.matchAll(regex)];
    const output = {};
    for (let index = 0; index < matches.length; index += 1) {
      const label = matches[index][1];
      if (!allowed.has(label)) continue;
      const start = matches[index].index + matches[index][0].length;
      const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
      output[label] = collapseRepeatedText(text.slice(start, end));
    }
    return output;
  }

  function parseFormattedExperience(value, inheritedCompany = "", inheritedCompanyUrl = "", inheritedCompanyImageUrl = "") {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return {
        title: collapseRepeatedText(value.title),
        company: collapseRepeatedText(value.company || inheritedCompany),
        companyUrl: canonicalizeProfileUrl(value.companyUrl || inheritedCompanyUrl),
        companyImageUrl: cleanText(value.companyImageUrl || inheritedCompanyImageUrl),
        employmentType: collapseRepeatedText(value.employmentType),
        dateRange: collapseRepeatedText(value.dateRange),
        duration: collapseRepeatedText(value.duration),
        location: collapseRepeatedText(value.location),
        workMode: collapseRepeatedText(value.workMode),
        description: collapseRepeatedText(value.description),
        isCurrent: Boolean(value.isCurrent || /\b(?:present|current)\b/i.test(value.dateRange || ""))
      };
    }
    const fields = parseLabeledFields(value);
    if (!Object.keys(fields).length) return null;
    return {
      title: fields.Title || "",
      company: fields.Company || inheritedCompany || "",
      companyUrl: canonicalizeProfileUrl(fields["Company URL"] || inheritedCompanyUrl || ""),
      companyImageUrl: cleanText(fields["Company Image"] || inheritedCompanyImageUrl || ""),
      employmentType: fields.Type || "",
      dateRange: fields.Dates || "",
      duration: fields.Duration || "",
      location: fields.Location || "",
      workMode: fields.Mode || "",
      description: fields.Description || "",
      isCurrent: /\b(?:present|current)\b/i.test(fields.Dates || "")
    };
  }

  function normalizeCompanyName(value) {
    const text = collapseRepeatedText(value)
      .replace(/\((?:formerly|previously|formerly known as)[^)]+\)/gi, " ")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/\b(?:private|pvt|limited|ltd|incorporated|inc|llc|llp|corporation|corp|company|co)\b\.?/g, " ")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text;
  }

  /**
   * A looser comparison than `companiesMatch`, used only when a role's title and
   * visible date range already match exactly. It accepts the shortened label
   * LinkedIn paints first ("Acme") against the full one that arrives with the
   * company link ("Acme Systems Pvt. Ltd."), which `companiesMatch` rejects
   * because "acme" is under its five-character brand threshold.
   */
  function companyNamesCompatible(left, right) {
    const a = normalizeCompanyName(left);
    const b = normalizeCompanyName(right);
    if (!a || !b) return true;
    return companiesMatch(left, right) || a.startsWith(b) || b.startsWith(a);
  }

  function companiesMatch(left, right) {
    const a = normalizeCompanyName(left);
    const b = normalizeCompanyName(right);
    if (!a || !b) return false;
    if (a === b) return true;
    const aTokens = a.split(" ");
    const bTokens = b.split(" ");
    const firstMatches = aTokens[0] === bTokens[0] && aTokens[0].length >= 5;
    const oneIsShortBrand = aTokens.length === 1 || bTokens.length === 1;
    return firstMatches && oneIsShortBrand && (a.startsWith(b) || b.startsWith(a));
  }

  function chooseCompanyName(current, candidate) {
    const a = collapseRepeatedText(current);
    const b = collapseRepeatedText(candidate);
    if (!a) return b;
    if (!b) return a;
    const aOfficial = /\b(?:pvt|private|ltd|limited|inc|llc|llp|corporation|corp)\b/i.test(a);
    const bOfficial = /\b(?:pvt|private|ltd|limited|inc|llc|llp|corporation|corp)\b/i.test(b);
    if (aOfficial !== bOfficial) return bOfficial ? b : a;
    return b.length > a.length ? b : a;
  }

  function parseExperienceGroup(value) {
    const text = cleanText(value);
    if (!text) return null;
    const marker = " | Roles: ";
    const markerIndex = text.indexOf(marker);
    const rolesOnly = text.startsWith("Roles: ");
    if (markerIndex < 0 && !rolesOnly) {
      const role = parseFormattedExperience(text);
      if (!role) return null;
      return { company: role.company, companyUrl: role.companyUrl, companyImageUrl: role.companyImageUrl, roles: [role] };
    }

    const headerText = rolesOnly ? "" : text.slice(0, markerIndex);
    const header = parseLabeledFields(headerText, ["Company", "Company URL", "Company Image"]);
    const company = header.Company || "";
    const companyUrl = canonicalizeProfileUrl(header["Company URL"] || "");
    const companyImageUrl = cleanText(header["Company Image"] || "");
    const roleText = rolesOnly ? text.slice("Roles: ".length) : text.slice(markerIndex + marker.length);
    const roles = roleText.split(EXPERIENCE_ROLE_SEPARATOR)
      .map((item) => item.replace(/^Role\s+\d+:\s*/i, "").replace(/^\[|\]$/g, ""))
      .map((item) => parseFormattedExperience(item, company, companyUrl, companyImageUrl))
      .filter(Boolean);
    return roles.length ? { company, companyUrl, companyImageUrl, roles } : null;
  }

  function formatRoleForCompany(record) {
    const fields = [
      ["Title", record.title],
      ["Type", record.employmentType],
      ["Dates", record.dateRange],
      ["Duration", record.duration],
      ["Location", record.location],
      ["Mode", record.workMode],
      ["Description", record.description]
    ];
    return fields.filter(([, value]) => cleanText(value)).map(([label, value]) => `${label}: ${collapseRepeatedText(value)}`).join(" | ");
  }

  function groupExperienceByCompany(inputRecords) {
    const records = [];
    for (const input of inputRecords || []) {
      if (typeof input === "string") {
        const parsedGroup = parseExperienceGroup(input);
        if (parsedGroup) records.push(...parsedGroup.roles.map((role) => ({
          ...role,
          company: role.company || parsedGroup.company,
          companyUrl: role.companyUrl || parsedGroup.companyUrl,
          companyImageUrl: role.companyImageUrl || parsedGroup.companyImageUrl
        })));
      } else {
        const parsed = parseFormattedExperience(input);
        if (parsed) records.push(parsed);
      }
    }

    const groups = [];
    for (const record of records) {
      // A company card may never be named "Full-time" or "9 mos": grouping on
      // employment metadata invents an organization that does not exist.
      const company = sanitizeCompanyName(record.company);
      const companyUrl = canonicalizeProfileUrl(record.companyUrl || "");
      const companyImageUrl = cleanText(record.companyImageUrl || "");
      let group = groups.find((candidate) => {
        if (companyUrl && candidate.companyUrl) return companyUrl === candidate.companyUrl;
        if (companyUrl && !candidate.companyUrl && companiesMatch(company, candidate.company)) return true;
        if (!companyUrl && candidate.companyUrl && companiesMatch(company, candidate.company)) return true;
        return companiesMatch(company, candidate.company);
      });
      if (!group) {
        group = { company, companyUrl, companyImageUrl, roles: [] };
        groups.push(group);
      } else {
        group.company = chooseCompanyName(group.company, company);
        group.companyUrl ||= companyUrl;
        group.companyImageUrl ||= companyImageUrl;
      }

      const duplicate = group.roles.some((existing) => [existing.title, existing.dateRange, existing.location]
        .map(comparisonKey).join("|") === [record.title, record.dateRange, record.location].map(comparisonKey).join("|"));
      if (!duplicate) group.roles.push({
        ...record,
        company: group.company,
        companyUrl: group.companyUrl,
        companyImageUrl: group.companyImageUrl
      });
    }

    for (const group of groups) {
      group.roles.sort((a, b) => {
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
        const aRange = parseDateRange(a.dateRange || "");
        const bRange = parseDateRange(b.dateRange || "");
        return (bRange?.end ?? -1) - (aRange?.end ?? -1) || (bRange?.start ?? -1) - (aRange?.start ?? -1);
      });
    }
    return groups;
  }

  function formatExperienceGroup(group) {
    if (!group?.roles?.length) return "";
    const header = [["Company", group.company], ["Company URL", group.companyUrl], ["Company Image", group.companyImageUrl]]
      .filter(([, value]) => cleanText(value))
      .map(([label, value]) => `${label}: ${collapseRepeatedText(value)}`)
      .join(" | ");
    const roles = group.roles.map((record, index) => `Role ${index + 1}: [${formatRoleForCompany(record)}]`).join(EXPERIENCE_ROLE_SEPARATOR);
    return [header, `Roles: ${roles}`].filter(Boolean).join(" | ");
  }

  function parseEducationLines(inputLines) {
    const lines = cleanEntityLines(inputLines).filter((line) => !/^education$/i.test(line));
    if (!lines.length) return null;
    const dateIndex = lines.findIndex(looksLikeDateRange);
    const beforeDate = dateIndex >= 0 ? lines.slice(0, dateIndex) : lines.slice(0, 3);
    const afterDate = dateIndex >= 0 ? lines.slice(dateIndex + 1) : lines.slice(3);

    let institution = beforeDate.find((line) => !DEGREE_PATTERN.test(line)) || beforeDate[0] || "";
    let degreeParts = beforeDate.filter((line) => comparisonKey(line) !== comparisonKey(institution));
    if (!degreeParts.length && beforeDate.length > 1) degreeParts = beforeDate.slice(1);
    let degreeText = collapseRepeatedText(degreeParts.join(" | "));
    let fieldOfStudy = "";

    const commaParts = degreeText.split(/\s*,\s*/).filter(Boolean);
    if (commaParts.length >= 2 && comparisonKey(commaParts[0]) !== comparisonKey(commaParts[1])) {
      degreeText = commaParts[0];
      fieldOfStudy = collapseRepeatedText(commaParts.slice(1).join(", "));
    }

    const blocked = new Set([institution, degreeText, fieldOfStudy].map(comparisonKey).filter(Boolean));
    const details = dedupeDescriptionLines(afterDate)
      .filter((line) => !blocked.has(comparisonKey(line)))
      .join(" • ");

    return {
      institution: collapseRepeatedText(institution),
      degree: collapseRepeatedText(degreeText),
      fieldOfStudy,
      dates: dateIndex >= 0 ? splitDateDetails(lines[dateIndex]).dateRange : "",
      details
    };
  }

  function formatEducation(record) {
    if (!record) return "";
    const fields = [
      ["Institution", record.institution],
      ["Degree", record.degree],
      ["Field", record.fieldOfStudy],
      ["Dates", record.dates],
      ["Details", record.details]
    ];
    return fields.filter(([, value]) => cleanText(value)).map(([label, value]) => `${label}: ${collapseRepeatedText(value)}`).join(" | ");
  }

  // ------------------------------------------------------- the readable forms
  //
  // `formatExperience` / `formatEducation` above write the LABELLED form, which
  // exists so a record can be parsed back out of a string. These write the form a
  // person reads — the line the table cell, the details panel and the CSV column
  // show. Both are kept, and neither is derived from the other: the labelled form
  // is a parse target and this is presentation, and collapsing them would mean
  // one of the two doing its job badly.

  /** One role: "Senior Lecturer — The Narayana Group · Full-time · Jun 2023 - Present". */
  function describeExperienceRecord(record) {
    if (!record) return "";
    const head = [cleanText(record.title), cleanText(record.company)].filter(Boolean).join(" — ");
    const parts = [
      head,
      cleanText(record.employmentType),
      cleanText(record.dateRange),
      cleanText(record.duration),
      cleanText(record.location),
      cleanText(record.workMode),
      cleanText(record.description)
    ].filter(Boolean);
    return parts.join(" · ");
  }

  /** One school: "BIT Sindri — BTEC, Chemical Engineering · 2019 – 2023". */
  function describeEducationRecord(record) {
    if (!record) return "";
    const qualification = [cleanText(record.degree), cleanText(record.fieldOfStudy)].filter(Boolean).join(", ");
    const head = [cleanText(record.institution), qualification].filter(Boolean).join(" — ");
    return [head, cleanText(record.dates), cleanText(record.details)].filter(Boolean).join(" · ");
  }

  function parseMonthPoint(value, isEnd = false, now = new Date()) {
    const text = cleanText(value).toLowerCase();
    if (/present|current/.test(text)) return now.getFullYear() * 12 + now.getMonth();
    const yearMatch = text.match(/\b((?:19|20)\d{2})\b/);
    if (!yearMatch) return null;
    const year = Number(yearMatch[1]);
    const monthName = Object.keys(MONTHS).find((name) => new RegExp(`\\b${name}\\b`, "i").test(text));
    const month = monthName ? MONTHS[monthName] : (isEnd ? 11 : 0);
    return year * 12 + month;
  }

  function parseDateRange(value, now = new Date()) {
    const text = splitDateDetails(value).dateRange.replace(/\s+/g, " ");
    const parts = text.split(/\s*(?:–|—|\bto\b|(?<!\d)-(?!\d))\s*/i);
    if (parts.length < 2) return null;
    const start = parseMonthPoint(parts[0], false, now);
    const end = parseMonthPoint(parts[1], true, now);
    if (start === null || end === null || end < start) return null;
    return { start, end };
  }

  function calculateTotalExperience(records, now = new Date()) {
    const intervals = [];
    for (const record of records || []) {
      if (!record || /\b(?:intern|internship|trainee|apprentice)\b/i.test(record.title || "")) continue;
      const range = parseDateRange(record.dateRange || "", now);
      if (range) intervals.push(range);
    }
    if (!intervals.length) return "";
    intervals.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const range of intervals) {
      const last = merged.at(-1);
      if (!last || range.start > last.end + 1) merged.push({ ...range });
      else last.end = Math.max(last.end, range.end);
    }
    const months = merged.reduce((sum, range) => sum + Math.max(1, range.end - range.start + 1), 0);
    const years = Math.floor(months / 12);
    const remainder = months % 12;
    return [years ? `${years} year${years === 1 ? "" : "s"}` : "", remainder ? `${remainder} month${remainder === 1 ? "" : "s"}` : ""].filter(Boolean).join(" ");
  }

  // ---------------------------------------------------------- profile page scan
  // LinkedIn renders a profile in slices as it is scrolled and recycles sections
  // that leave the viewport, so reading the page once - or stopping at the first
  // sight of the bottom - loses data. The scan walks from the top to the bottom
  // and only finishes when the page has stopped changing while at the bottom.
  // The decision is pure so it can be tested against a simulated page.

  const PROFILE_SCAN = Object.freeze({
    MAX_STEPS: 90,
    // Five consecutive reads at the bottom must produce nothing new before the
    // profile is considered complete. Three was not enough live: a virtualized
    // Skills or Certifications list can stall for two reads and then deliver.
    QUIET_PASSES: 5,
    STEP_RATIO: 0.7,
    MIN_STEP: 560,
    BOTTOM_EPSILON: 8
  });

  function createScanState(patch = {}) {
    return {
      position: 0,
      steps: 0,
      unchangedPasses: 0,
      lastSignature: "",
      atBottom: false,
      done: false,
      reason: "start",
      ...patch
    };
  }

  /**
   * Fold one observation of the page into the scan state and choose where to
   * scroll next.
   *
   * `signature` must summarize everything the caller cares about having rendered
   * (page height plus how much has been collected so far). A signature that keeps
   * changing means content is still arriving, so the scan keeps going even when
   * the page reports that it is already at the bottom.
   */
  function nextScanStep(state, page = {}) {
    const previous = createScanState(state || {});
    const maxPosition = Math.max(0, Number(page.maxPosition) || 0);
    const position = Math.min(Math.max(0, Number(page.position) || 0), maxPosition);
    const viewportHeight = Math.max(200, Number(page.viewportHeight) || 800);
    const signature = String(page.signature ?? "");

    const changed = signature !== previous.lastSignature;
    const unchangedPasses = changed ? 0 : previous.unchangedPasses + 1;
    const atBottom = position >= maxPosition - PROFILE_SCAN.BOTTOM_EPSILON;
    const steps = previous.steps + 1;
    const base = { position, steps, unchangedPasses, lastSignature: signature, atBottom };

    // Finished only when the bottom has been reached AND repeated reads there
    // revealed nothing new. Either condition alone would cut the profile short.
    if (atBottom && unchangedPasses >= PROFILE_SCAN.QUIET_PASSES) {
      return createScanState({ ...base, done: true, reason: "settled" });
    }
    if (steps >= PROFILE_SCAN.MAX_STEPS) {
      return createScanState({ ...base, done: true, reason: "step-budget" });
    }

    const stepSize = Math.max(PROFILE_SCAN.MIN_STEP, Math.round(viewportHeight * PROFILE_SCAN.STEP_RATIO));
    const nextPosition = atBottom ? maxPosition : Math.min(position + stepSize, maxPosition);
    return createScanState({
      ...base,
      position: nextPosition,
      done: false,
      reason: atBottom ? "wait-at-bottom" : "scroll"
    });
  }

  // -------------------------------------------------- the Contact info overlay
  // The overlay is FETCHED: LinkedIn mounts an empty modal shell first and fills
  // the member's details in afterwards. Reading it the moment it appears reads a
  // skeleton, which is exactly how a click could open the overlay and still
  // collect nothing. The wait is therefore a settle loop like the page scan, and
  // the decision part of it lives here, pure, so it is tested without a DOM.

  const CONTACT_OVERLAY = Object.freeze({
    POLL_MS: 250,
    // Waiting for the modal to exist at all. On a throttled tab or a slow fetch
    // this is seconds, not the single beat it takes on an idle machine.
    OPEN_TIMEOUT_MS: 10000,
    // Waiting for the values to arrive once the shell is up.
    LOAD_TIMEOUT_MS: 12000,
    // An overlay that has parsed nothing yet is never called finished before
    // this, whatever the markup claims: LinkedIn's placeholder classes change,
    // and "no skeleton visible" is not proof the fetch has returned.
    MIN_LOAD_MS: 1500,
    // Consecutive agreeing reads. Fewer than this and a two-stage hydration
    // (address first, number a beat later) reads as finished after stage one.
    QUIET_PASSES: 3
  });

  function createContactOverlayState(patch = {}) {
    return {
      waited: 0,
      reads: 0,
      quiet: 0,
      lastSignature: "",
      settled: false,
      done: false,
      reason: "start",
      ...patch
    };
  }

  /**
   * One poll of the opened overlay.
   *
   * `observation` is everything the adapter can see right now:
   *   `waitedMs`     - how long the overlay has been open
   *   `present`      - the dialog is still in the document
   *   `visible`      - the page is still being painted
   *   `loading`      - the dialog is still showing placeholders
   *   `carriesValue` - at least one address, number, CV or website was parsed
   *   `signature`    - fingerprint of what the dialog currently shows
   *
   * Settled needs the dialog to have stopped showing placeholders AND
   * `QUIET_PASSES` reads in a row that agree AND either a value already parsed
   * out of it or `MIN_LOAD_MS` elapsed. The last clause is what stops an overlay
   * that genuinely has nothing in it from costing the whole load timeout, while
   * still never calling an empty panel finished in the first second.
   */
  function nextContactOverlayStep(previous = createContactOverlayState(), observation = {}) {
    const state = createContactOverlayState(previous);
    const waited = Math.max(0, Number(observation.waitedMs) || 0);

    // A page LinkedIn is not painting cannot be read, and a partial read must
    // never be reported as "this member has no contact details".
    if (observation.visible === false) {
      return createContactOverlayState({ ...state, waited, done: true, reason: "page-hidden" });
    }
    if (!observation.present) {
      return createContactOverlayState({ ...state, waited, done: true, reason: "overlay-closed-early" });
    }

    const signature = String(observation.signature ?? "");
    const agreed = signature === state.lastSignature;
    const quiet = !observation.loading && agreed ? state.quiet + 1 : 0;
    const base = { ...state, waited, reads: state.reads + 1, quiet, lastSignature: signature };

    const longEnough = Boolean(observation.carriesValue) || waited >= CONTACT_OVERLAY.MIN_LOAD_MS;
    if (quiet >= CONTACT_OVERLAY.QUIET_PASSES && longEnough) {
      return createContactOverlayState({ ...base, settled: true, done: true, reason: "settled" });
    }
    if (waited >= CONTACT_OVERLAY.LOAD_TIMEOUT_MS) {
      return createContactOverlayState({ ...base, done: true, reason: "load-timeout" });
    }
    return createContactOverlayState({ ...base, reason: observation.loading ? "loading" : "hydrating" });
  }

  // ------------------------------------------------ virtualization accumulator
  // LinkedIn mounts a profile section when it nears the viewport and unmounts it
  // once the viewport has moved past. Reading the page once - or reading it only
  // after scrolling to the bottom - therefore sees a different subset of the
  // profile than the user does. Everything read at every scroll position is
  // folded in here instead, keyed so that the same entity seen again is merged
  // rather than duplicated, and so that a later, more hydrated read can fill in
  // values the first read was too early to see.

  function normalizeDegree(value) {
    return comparisonKey(value).replace(/\s+/g, "");
  }

  /** Experience identity: canonical company URL + normalized title + date range. */
  function experienceKey(record) {
    const companyUrl = canonicalizeProfileUrl(record?.companyUrl || "");
    const company = companyUrl || normalizeCompanyName(record?.company);
    return [company, comparisonKey(record?.title), comparisonKey(record?.dateRange)].join("|");
  }

  /** Education identity: normalized institution + normalized degree + date range. */
  function educationKey(record) {
    return [comparisonKey(record?.institution), normalizeDegree(record?.degree), comparisonKey(record?.dates)].join("|");
  }

  /** Skill identity: the lowercase normalized skill name. */
  function skillKey(value) {
    return comparisonKey(typeof value === "string" ? value : value?.name);
  }

  function certificationRecord(value) {
    if (value && typeof value === "object") {
      return {
        name: collapseRepeatedText(value.name),
        issuer: collapseRepeatedText(value.issuer),
        date: collapseRepeatedText(value.date || value.dates),
        credentialId: collapseRepeatedText(value.credentialId),
        credentialUrl: cleanText(value.credentialUrl)
      };
    }
    const parts = String(value ?? "").split(" | ").map(collapseRepeatedText);
    return {
      name: parts[0] || "",
      issuer: parts[1] || "",
      date: parts[2] || "",
      credentialId: parts[3] || "",
      credentialUrl: parts[4] || ""
    };
  }

  /** Certification identity: normalized name + issuer + issue date. */
  function certificationKey(value) {
    const record = certificationRecord(value);
    return [comparisonKey(record.name), comparisonKey(record.issuer), comparisonKey(record.date)].join("|");
  }

  function formatCertification(record) {
    return [record.name, record.issuer, record.date, record.credentialId, record.credentialUrl].filter(Boolean).join(" | ");
  }

  /**
   * Fill blanks from a later read without ever overwriting a value that is
   * already there. A missing value stays missing: nothing is invented.
   */
  function mergeEntityRecords(existing, incoming, longerFields = []) {
    const merged = { ...existing };
    for (const [key, value] of Object.entries(incoming || {})) {
      const next = typeof value === "string" ? value : value;
      if (typeof next === "boolean") {
        merged[key] = Boolean(merged[key]) || next;
        continue;
      }
      if (typeof next !== "string") {
        if (merged[key] === undefined || merged[key] === "") merged[key] = next;
        continue;
      }
      const cleaned = cleanText(next);
      if (!cleaned) continue;
      const current = cleanText(merged[key]);
      if (!current) merged[key] = cleaned;
      else if (longerFields.includes(key) && cleaned.length > current.length) merged[key] = cleaned;
    }
    return merged;
  }

  function experienceRecord(input) {
    const record = parseFormattedExperience(input) || {};
    // The last line of defence: whatever the DOM adapter produced, employment
    // metadata never enters the accumulator as a company or a role title.
    const company = sanitizeCompanyName(record.company);
    return {
      title: sanitizeRoleTitle(record.title, company),
      company,
      companyUrl: canonicalizeProfileUrl(record.companyUrl || ""),
      companyImageUrl: cleanText(record.companyImageUrl),
      employmentType: collapseRepeatedText(record.employmentType),
      dateRange: collapseRepeatedText(record.dateRange),
      duration: collapseRepeatedText(record.duration),
      location: collapseRepeatedText(record.location),
      workMode: collapseRepeatedText(record.workMode),
      description: collapseRepeatedText(record.description),
      isCurrent: Boolean(record.isCurrent)
    };
  }

  function educationRecord(input) {
    if (typeof input === "string") {
      const fields = parseLabeledFields(input, ["Institution", "Degree", "Field", "Dates", "Details"]);
      return {
        institution: fields.Institution || "",
        degree: fields.Degree || "",
        fieldOfStudy: fields.Field || "",
        dates: fields.Dates || "",
        details: fields.Details || ""
      };
    }
    return {
      institution: collapseRepeatedText(input?.institution),
      degree: collapseRepeatedText(input?.degree),
      fieldOfStudy: collapseRepeatedText(input?.fieldOfStudy),
      dates: collapseRepeatedText(input?.dates),
      details: collapseRepeatedText(input?.details)
    };
  }

  /**
   * One education card per institution. Extra qualifications at the same school
   * are appended to that card's details rather than becoming a second card.
   */
  function groupEducationByInstitution(records) {
    const groups = [];
    const index = new Map();
    for (const input of records || []) {
      const record = educationRecord(input);
      if (!record.institution) continue;
      const key = comparisonKey(record.institution);
      const existing = index.get(key);
      if (!existing) {
        index.set(key, record);
        groups.push(record);
        continue;
      }
      // The first card keeps its own degree; a genuinely different qualification
      // is recorded in Details so nothing read from the page is thrown away.
      const merged = mergeEntityRecords(existing, { ...record, degree: "", dates: "", details: "" }, ["details"]);
      const extra = [record.degree, record.dates].filter(Boolean).join(" ").trim();
      const alreadyListed = normalizeDegree(record.degree) === normalizeDegree(existing.degree)
        && comparisonKey(record.dates) === comparisonKey(existing.dates);
      if (extra && !alreadyListed && !merged.details.includes(extra)) {
        merged.details = [merged.details, extra].filter(Boolean).join(" • ");
      }
      Object.assign(existing, merged);
    }
    return groups;
  }

  // ------------------------------------------------------- contact details & CV
  // The collected record is now led by contact reachability - CV, email, mobile -
  // so these have to be as strict as the entity parsers: a value that is not
  // provably an address, a phone number, or a document is dropped rather than
  // guessed at. Every function here is pure and string-in/string-out, so the
  // whole policy is tested without a DOM.

  /**
   * Deliberately narrower than RFC 5322: LinkedIn renders addresses as plain text
   * inside sentences, so a permissive pattern swallows the trailing punctuation
   * and the next word with it.
   */
  const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/gi;

  /**
   * International and national forms, with the separators LinkedIn actually
   * emits. The digit-count check in `normalizePhone` is what rejects a year
   * range, an employee count, or a postal code that happens to match.
   */
  const PHONE_PATTERN = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,5}\)[\s.-]?)?\d[\d\s.\-()]{5,20}\d/g;

  /**
   * Any address-looking run of text.
   *
   * Live defect: every LinkedIn vanity URL ends in the member's numeric id, so
   * `linkedin.com/in/paarth-khandelwal-264954380` handed `264954380` to
   * `PHONE_PATTERN` and it was saved as a mobile number on profile after
   * profile. A URL is never a phone number, so it is deleted from the text
   * before any number is looked for.
   */
  const URL_TEXT_PATTERN =
    /(?:https?:\/\/|www\.)\S+|[a-z0-9][a-z0-9-]*\.(?:com|org|net|io|co|in|dev|me|ai|app|xyz|info|biz|edu|gov|uk|us|de|fr)\b\S*/gi;

  /**
   * Digits welded to a word — a vanity slug (`khandelwal-264954380`), an
   * identifier (`ID2938471`), a credential number. LinkedIn writes a phone
   * number with spaces, brackets, dots or dashes, never against a letter, so
   * removing these cannot remove a real number.
   */
  const GLUED_DIGITS_SOURCE = "[A-Za-z_][A-Za-z_-]*\\d[\\d-]*|\\d[\\d-]*[A-Za-z_][A-Za-z_]*";
  const GLUED_DIGITS_PATTERN = new RegExp(GLUED_DIGITS_SOURCE, "g");
  /** The same rule as a one-shot test — a `/g` regex carries `lastIndex` state. */
  const HAS_GLUED_DIGITS = new RegExp(GLUED_DIGITS_SOURCE);

  /**
   * Words that make a link a CV rather than a personal site.
   *
   * "portfolio" is deliberately NOT here. A portfolio is a personal site: it
   * belongs in `websites`, and promoting it filled the CV column with links that
   * were not CVs. The CV field carries CVs and resumes only.
   */
  const CV_LABEL_PATTERN = /\b(?:cv|resume|resum[eé]|r[eé]sum[eé]|curriculum[\s_-]?vitae)\b/i;

  /** A link that points at a document file is a CV candidate on its own. */
  const DOCUMENT_URL_PATTERN = /\.(?:pdf|docx?|odt|rtf|pages)(?:$|[?#])/i;

  /**
   * Hosts that exist to publish a CV. Landing on one IS the evidence.
   */
  const RESUME_HOST_PATTERN = /(?:read\.cv|standardresume\.co|resume\.io|flowcv\.|novoresume\.com|resume\.com|kickresume\.com)/i;

  /**
   * General-purpose document hosts. A link to one is a CV only when something
   * else also says so: a shared Drive folder of holiday photos is not a resume,
   * and treating every `drive.google.com` link as one is how ordinary links
   * ended up in the CV column.
   */
  const DOCUMENT_HOST_PATTERN =
    /(?:docs\.google\.com\/document|drive\.google\.com|dropbox\.com|1drv\.ms|onedrive\.live\.com|box\.com\/s|icloud\.com\/iclouddrive|notion\.(?:so|site))/i;

  /** Any linkedin.com address. Navigation, never a contact detail or a CV. */
  const LINKEDIN_URL_PATTERN = /^https?:\/\/(?:[a-z0-9-]+\.)*linkedin\.com(?:[/?#]|$)/i;

  /**
   * LinkedIn wraps outbound links in its own redirector. The target is what
   * matters — left wrapped, a real CV looks like a LinkedIn URL and is thrown
   * away, and a stored link points at LinkedIn instead of the document.
   */
  function unwrapRedirectUrl(value) {
    const url = cleanText(value);
    if (!LINKEDIN_URL_PATTERN.test(url)) return url;
    try {
      const parsed = new URL(url);
      if (!/\/(?:redir\/redirect|safety\/go)\b/i.test(parsed.pathname)) return url;
      const target = parsed.searchParams.get("url") || parsed.searchParams.get("u");
      const cleaned = cleanText(target);
      return /^https?:\/\//i.test(cleaned) ? cleaned : url;
    } catch {
      return url;
    }
  }

  /** Text that is a label for a value, never the value itself. */
  const CONTACT_LABEL_NOISE = /^(?:email|e-?mail address|phone|mobile|telephone|tel|contact|contact info|address|website|websites|profile|twitter|im|birthday|connected)\b[:\s]*$/i;

  function normalizeEmail(value) {
    const text = cleanText(value).replace(/^mailto:/i, "").split(/[?\s]/)[0].replace(/[.,;:]+$/, "");
    if (!text) return "";
    // A single match that spans the WHOLE remaining string; anything else is a
    // sentence that merely contains an address, and the caller should scan it.
    const match = text.match(new RegExp(`^${EMAIL_PATTERN.source}$`, "i"));
    return match ? match[0].toLowerCase() : "";
  }

  /**
   * Reduce a phone number to `+<digits>` / `<digits>`, or "" when the value is not
   * plausibly a phone number at all. 7-15 digits is the E.164 range, which is what
   * separates a real number from "2019 - 2023" or "1,204 followers".
   */
  function normalizePhone(value) {
    const raw = cleanText(value).replace(/^tel:/i, "");
    if (!raw) return "";
    // A URL, a path, or an address is never a phone number however many digits
    // it carries. This is the last line of defence behind `extractPhones`, and
    // it is what stops a bare vanity slug reaching the record.
    if (/[/@]|(?:^|[^\d])[a-z0-9-]+\.[a-z]{2,}/i.test(raw)) return "";
    if (HAS_GLUED_DIGITS.test(raw)) return "";
    if (/[a-z]/i.test(raw.replace(/\b(?:ext|x|tel|mobile|phone|cell|work|home)\b/gi, ""))) return "";
    // A date range is two 4-digit years and lands squarely inside the 7-15 digit
    // window, so "2019 - 2023" would otherwise be saved as somebody's mobile.
    if (looksLikeDateRange(raw)) return "";
    if (/^\D*(?:19|20)\d{2}\s*[-–—to]+\s*(?:19|20)\d{2}\D*$/i.test(raw)) return "";
    const plus = /^\s*\+/.test(raw);
    const digits = raw.replace(/\D/g, "");
    if (digits.length < 7 || digits.length > 15) return "";
    // All-identical digits is a placeholder, not a number.
    if (/^(\d)\1+$/.test(digits)) return "";
    return plus ? `+${digits}` : digits;
  }

  /** Every address in a block of visible text, deduped, in reading order. */
  function extractEmails(value) {
    const text = cleanText(value);
    if (!text) return [];
    const found = text.match(EMAIL_PATTERN) || [];
    return uniqueText(found.map((entry) => normalizeEmail(entry)).filter(Boolean));
  }

  /**
   * Every phone number in a block of visible text, deduped, in reading order.
   *
   * Addresses, URLs and identifiers all contain long digit runs, and all three
   * were being saved as mobile numbers. They are deleted from the text first, so
   * `PHONE_PATTERN` only ever sees what is left over.
   */
  function extractPhones(value) {
    const text = cleanText(value);
    if (!text) return [];
    const scrubbed = text
      .replace(EMAIL_PATTERN, " ")
      .replace(URL_TEXT_PATTERN, " ")
      .replace(GLUED_DIGITS_PATTERN, " ");
    const found = scrubbed.match(PHONE_PATTERN) || [];
    return uniqueText(found.map((entry) => normalizePhone(entry)).filter(Boolean));
  }

  /**
   * The labels LinkedIn writes above a contact value, and what each one means.
   *
   * Longest first: `phone` would otherwise match "phone number" and leave the
   * word "number" behind as the value. `other` is every remaining contact label
   * — matching one CLOSES the field that was open, which is what stops the
   * profile URL printed under "Your Profile" from being read as a phone number.
   */
  const CONTACT_FIELD_LABELS = [
    { kind: "email", pattern: /^(?:e-?mail addresses|e-?mail address|e-?mails|e-?mail)\b/i },
    {
      kind: "phone",
      pattern: /^(?:phone numbers|phone number|mobile numbers|mobile number|contact numbers|contact number|telephones|telephone|whats\s?app|phones|phone|mobiles|mobile|cells|cell|tel)\b/i
    },
    {
      kind: "other",
      pattern: /^(?:your profile|profiles|profile|websites|website|addresses|address|birthdays|birthday|connected|instant messaging|im|twitter|social|contact information|contact info|interests|languages|about)\b/i
    }
  ];

  /**
   * Read one line as `<label>` or `<label>: <value>`.
   * Returns null when the line is not a contact label at all.
   */
  function readContactLabelLine(value) {
    const text = cleanText(value);
    if (!text) return null;
    for (const { kind, pattern } of CONTACT_FIELD_LABELS) {
      const match = pattern.exec(text);
      if (!match) continue;
      const rest = cleanText(text.slice(match[0].length).replace(/^\s*[:•·–—-]\s*/, ""));
      return { kind, value: rest };
    }
    return null;
  }

  /**
   * Addresses and numbers from visible text, taken ONLY from a labelled field.
   *
   * Live defect: the whole profile was swept for anything shaped like an address
   * or a number, so the "Interests" block — which renders OTHER members, their
   * addresses and their numbers — put a stranger's email and mobile on the
   * record. A value now has to sit under a label that says what it is, and any
   * other contact label closes the field again.
   */
  function scanLabelledContacts(value) {
    const emails = [];
    const phones = [];
    let active = "";
    for (const rawLine of String(value ?? "").split(/\r?\n/)) {
      const line = cleanText(rawLine);
      if (!line) continue;
      const labelled = readContactLabelLine(line);
      if (labelled) {
        active = labelled.kind === "other" ? "" : labelled.kind;
        if (!labelled.value) continue;
        if (labelled.kind === "email") emails.push(...extractEmails(labelled.value));
        else if (labelled.kind === "phone") phones.push(...extractPhones(labelled.value));
        continue;
      }
      if (active === "email") emails.push(...extractEmails(line));
      else if (active === "phone") phones.push(...extractPhones(line));
    }
    return { emails: uniqueText(emails), phones: uniqueText(phones) };
  }

  /**
   * Is this link a CV/resume?
   *
   * True when the label says so, when the URL says so, or when it points at a
   * document file or a document host. Everything else is an ordinary website and
   * is kept separately rather than promoted to `cvUrl`.
   */
  function looksLikeCvLink({ href = "", label = "", context = "" } = {}) {
    const url = unwrapRedirectUrl(href);
    if (!url || /^(?:mailto|tel|javascript):/i.test(url)) return false;

    // A LinkedIn address is the member's own profile, a post, or an overlay of
    // the page being read. It is stored as `profileUrl`, and it is never a CV.
    if (LINKEDIN_URL_PATTERN.test(url)) return false;

    // Said outright — by the link's own label, or by the URL itself.
    if (CV_LABEL_PATTERN.test(cleanText(label))) return true;
    if (CV_LABEL_PATTERN.test(url)) return true;
    // A document file, or a host whose whole purpose is publishing a CV.
    if (DOCUMENT_URL_PATTERN.test(url)) return true;
    if (RESUME_HOST_PATTERN.test(url)) return true;
    // A general-purpose document host needs corroboration. The surrounding text
    // counts here and only here: on its own it is far too loose - one mention of
    // the word anywhere in a section would claim every link in it.
    if (DOCUMENT_HOST_PATTERN.test(url) && CV_LABEL_PATTERN.test(cleanText(context))) return true;
    return false;
  }

  /**
   * Sort one rendered link into the contact bucket it belongs in.
   * `kind` is "" when the link carries nothing worth storing.
   */
  function classifyContactLink({ href = "", label = "", context = "" } = {}) {
    const raw = cleanText(href);
    if (!raw) return { kind: "", value: "" };
    if (/^mailto:/i.test(raw)) {
      const email = normalizeEmail(raw);
      return email ? { kind: "email", value: email } : { kind: "", value: "" };
    }
    if (/^tel:/i.test(raw)) {
      const phone = normalizePhone(raw);
      return phone ? { kind: "phone", value: phone } : { kind: "", value: "" };
    }
    if (/^(?:javascript|data|blob):/i.test(raw)) return { kind: "", value: "" };

    // Unwrap first, so the redirector's own linkedin.com address is not what
    // gets tested — or stored.
    const url = unwrapRedirectUrl(raw);
    // A LinkedIn URL is navigation, not a contact detail. This is checked BEFORE
    // the CV test, not after: the member's own profile link is stored once, as
    // `profileUrl`, and must never also be offered as their CV.
    if (LINKEDIN_URL_PATTERN.test(url)) return { kind: "", value: "" };
    if (!/^https?:\/\//i.test(url)) return { kind: "", value: "" };
    if (looksLikeCvLink({ href: url, label, context })) return { kind: "cv", value: url };
    const text = cleanText(label);
    return { kind: "website", value: text && !CONTACT_LABEL_NOISE.test(text) ? `${text}: ${url}` : url };
  }

  /**
   * Read a rendered "Contact info" panel into structured values.
   *
   * The panel is a list of label/value pairs whose markup differs per account, so
   * this works off the text and the hrefs only. Both halves carry provenance:
   * a `mailto:`/`tel:` href says what it is, and a text value is only taken when
   * the line above it says what it is. Text that says neither is not a contact
   * detail, however much it looks like one.
   *
   * `allow` narrows which kinds the TEXT half may contribute. The rendered page
   * passes `["email"]`, because a labelled "Email:" line in someone's own About
   * is theirs — while a number in running text is indistinguishable from an id,
   * a count or a date and is never taken outside the overlay.
   *
   * `trusted` says this text came from a panel THIS EXTENSION OPENED ITSELF, on
   * the person being collected: the Contact info overlay, or an applicant's own
   * contact disclosure. Everything inside such a panel is that person's contact
   * details by construction — there is no Interests block in it and no other
   * member's card, which is the whole reason the labelled-provenance rule
   * exists. A trusted panel therefore yields **every** address and number it
   * shows, labelled or not. Without this, a locale or a markup revision that
   * renders the number under a heading `CONTACT_FIELD_LABELS` does not
   * recognise loses that number even though it is plainly on screen next to the
   * address. The scrubbing in `extractPhones` and every rejection in
   * `normalizePhone` still apply, so a URL, a member id, a date or a count
   * inside that panel still yields nothing.
   */
  function parseContactPanel({ text = "", links = [], allow = ["email", "phone"], trusted = false } = {}) {
    const emails = [];
    const phones = [];
    const cvLinks = [];
    const websites = [];
    const allowed = new Set(allow || []);

    for (const link of links || []) {
      const sorted = classifyContactLink(link || {});
      if (sorted.kind === "email") emails.push(sorted.value);
      else if (sorted.kind === "phone") phones.push(sorted.value);
      else if (sorted.kind === "cv") cvLinks.push(sorted.value);
      else if (sorted.kind === "website") websites.push(sorted.value);
    }

    const labelled = scanLabelledContacts(text);
    if (allowed.has("email")) emails.push(...labelled.emails);
    if (allowed.has("phone")) phones.push(...labelled.phones);

    // A panel we opened on this person: take everything in it. The labelled
    // pass above already ran, so this only ever ADDS what a heading this build
    // does not recognise would otherwise have hidden.
    if (trusted) {
      emails.push(...extractEmails(text));
      phones.push(...extractPhones(text));
    }

    return {
      emails: uniqueText(emails),
      phones: uniqueText(phones),
      cvLinks: uniqueText(cvLinks),
      websites: uniqueText(websites)
    };
  }

  // ------------------------------------------------------------- open to work
  // The badge on the picture says a member is looking; the details behind
  // "Show details" say what for. Both are read here, purely, so the content
  // script only has to supply the overlay's text.

  /**
   * The fields LinkedIn shows in the "Open to work" panel, in the order the
   * record stores them. `label` is what the stored line is called; `pattern`
   * matches the heading LinkedIn actually renders, which differs by locale
   * revision ("Location types" and "Workplace types" are the same field).
   */
  const OPEN_TO_WORK_FIELDS = [
    { key: "titles", label: "Job titles", pattern: /^(?:job titles?|titles?|roles? you'?re open to|open to roles?)\b/i },
    // The lookahead matters: "Location types" is the workplace field, not this
    // one, and `locations?` would otherwise claim it first.
    { key: "locations", label: "Locations", pattern: /^(?:preferred locations?|locations?(?!\s+types?\b)|where)\b/i },
    { key: "workplaceTypes", label: "Workplace types", pattern: /^(?:location types?|workplace types?|work(?:place)? preferences?|on-?site\/remote)\b/i },
    { key: "employmentTypes", label: "Employment types", pattern: /^(?:job types?|employment types?)\b/i },
    { key: "availability", label: "Availability", pattern: /^(?:start date|starting|availability|when can you start)\b/i }
  ];

  /** Chrome/heading text inside the panel that is never a value. */
  const OPEN_TO_WORK_NOISE =
    /^(?:open to work|job preferences|share with|visible to|all linkedin members|recruiters only|edit|close|dismiss|done|save|share your profile|see all jobs|show details|hide details)\b/i;

  /** Is this member advertising that they are open to work? */
  function looksOpenToWork(value) {
    return /\bopen to work\b|\bopentowork\b|\bopen for work\b/i.test(cleanText(value));
  }

  /**
   * Read the "Open to work" panel into its fields.
   *
   * Label-scoped exactly like the contact panel: a value belongs to the heading
   * above it, and an unrecognised heading closes the field rather than letting
   * the next block of text be filed under the last one seen.
   */
  function parseOpenToWorkPanel({ text = "" } = {}) {
    const found = new Map(OPEN_TO_WORK_FIELDS.map((field) => [field.key, []]));
    let active = "";
    for (const rawLine of String(text ?? "").split(/\r?\n/)) {
      const line = cleanText(rawLine);
      if (!line) continue;
      const field = OPEN_TO_WORK_FIELDS.find((entry) => entry.pattern.test(line));
      if (field) {
        active = field.key;
        const rest = cleanText(line.replace(field.pattern, "").replace(/^\s*[:•·–—-]\s*/, ""));
        if (rest && !OPEN_TO_WORK_NOISE.test(rest)) found.get(active).push(rest);
        continue;
      }
      if (OPEN_TO_WORK_NOISE.test(line)) {
        active = "";
        continue;
      }
      if (!active) continue;
      found.get(active).push(line);
    }
    const result = {};
    for (const field of OPEN_TO_WORK_FIELDS) {
      // LinkedIn writes several values on one line, comma separated, and
      // sometimes one per line. Both forms flatten to the same list.
      result[field.key] = uniqueText(
        found.get(field.key).flatMap((value) => value.split(/\s*(?:,|·|•|\|)\s*/)).map(cleanText).filter(Boolean)
      );
    }
    return result;
  }

  /**
   * The panel as the record stores it: one labelled line per field that carried
   * a value, led by the badge itself so a member who is open to work but showed
   * no details is still recorded as open to work.
   */
  function formatOpenToWork(panel = {}, { open = true } = {}) {
    if (!open) return [];
    const lines = ["Open to work: Yes"];
    for (const field of OPEN_TO_WORK_FIELDS) {
      const values = uniqueText(panel[field.key] || []);
      if (values.length) lines.push(`${field.label}: ${values.join(", ")}`);
    }
    return lines;
  }

  /**
   * Years of experience as a number, from the same merged intervals that produce
   * the human-readable total. Returns "" when no role carried a parseable range -
   * an unknown length is never reported as 0.
   */
  function calculateExperienceYears(records, now = new Date()) {
    const total = calculateTotalExperience(records, now);
    if (!total) return "";
    const years = Number(/(\d+)\s+years?/.exec(total)?.[1] || 0);
    const months = Number(/(\d+)\s+months?/.exec(total)?.[1] || 0);
    const value = years + months / 12;
    if (!Number.isFinite(value) || value <= 0) return "";
    // One decimal: "5.3" reads as a duration, "5.2500000001" does not.
    return String(Math.round(value * 10) / 10);
  }

  /**
   * The in-memory profile accumulator.
   *
   * Merge-only: nothing that has been read is ever dropped because a later scan
   * no longer has it in the DOM, and a later scan may only add detail.
   */
  function createProfileAccumulator() {
    const experience = new Map();
    const education = new Map();
    const skills = new Map();
    const certifications = new Map();
    const languages = new Map();
    // The companies, newsletters, schools and groups the member follows. Names
    // only — rule 2 still forbids reading a contact detail out of this block,
    // because everything in it belongs to somebody who is not this member.
    const interests = new Map();
    const partialSections = new Set();
    // Contact reachability is now the point of the record, so it accumulates
    // exactly like an entity does: merge-only, deduped, first-seen order.
    const emails = new Map();
    const phones = new Map();
    const cvLinks = new Map();
    const websites = new Map();
    // `headline` and `location` are no longer stored on the profile. They are
    // still accumulated because the role/company fallback is derived from the
    // headline, and a scored read is how the best copy of it is chosen.
    const identity = { name: "", nameScore: -1, headline: "", headlineScore: -1, location: "", locationScore: -1 };
    // Not stored on the profile any more, but still accumulated: a late-hydrating
    // About or Certifications section is real page change, and the scan's quiet
    // count must see it rather than declaring the page settled too early.
    let about = "";

    function addKeyed(map, key, record, longerFields) {
      if (!key || key.replace(/\|/g, "").trim() === "") return "ignored";
      const existing = map.get(key);
      if (!existing) {
        map.set(key, record);
        return "added";
      }
      map.set(key, mergeEntityRecords(existing, record, longerFields));
      return "merged";
    }

    function addSimple(map, value, validate = null) {
      const text = collapseRepeatedText(typeof value === "string" ? value : value?.name);
      const key = skillKey(text);
      if (!text || !key || map.has(key)) return "ignored";
      if (validate && !validate(text)) return "ignored";
      map.set(key, text);
      return "added";
    }

    /**
     * The company URL and logo hydrate after the text does, so the first read of a
     * role often has no URL and the third one does. Keyed strictly, those would be
     * two roles. Find the earlier, thinner copy of the same role - same title, same
     * dates, compatible company, and a URL on only one side - so the later read
     * enriches it and is then re-keyed under the more specific identity.
     */
    function findLooseExperienceMatch(record) {
      const title = comparisonKey(record.title);
      const dates = comparisonKey(record.dateRange);
      for (const [key, existing] of experience) {
        if (comparisonKey(existing.title) !== title) continue;
        if (comparisonKey(existing.dateRange) !== dates) continue;
        if (existing.companyUrl && record.companyUrl && existing.companyUrl !== record.companyUrl) continue;
        if (!companyNamesCompatible(existing.company, record.company)) continue;
        return { key, existing };
      }
      return null;
    }

    return {
      addExperience(input) {
        const record = experienceRecord(input);
        if (!record.title && !record.company) return "ignored";
        const key = experienceKey(record);
        if (!experience.has(key)) {
          const loose = findLooseExperienceMatch(record);
          if (loose) {
            const merged = mergeEntityRecords(loose.existing, record, ["description", "location", "duration"]);
            merged.company = chooseCompanyName(loose.existing.company, record.company);
            experience.delete(loose.key);
            experience.set(experienceKey(merged), merged);
            return "merged";
          }
        }
        return addKeyed(experience, key, record, ["description", "location", "duration"]);
      },
      addEducation(input) {
        const record = educationRecord(input);
        if (!record.institution) return "ignored";
        return addKeyed(education, educationKey(record), record, ["details"]);
      },
      addSkill(value) {
        // Endorsement controls and role sentences are not skills.
        return addSimple(skills, value, isSkillValue);
      },
      addLanguage(value) {
        return addSimple(languages, value, (text) => !SKILL_CONTROL_PATTERN.test(text) && !isEmploymentMeta(text));
      },
      addInterest(value) {
        return addSimple(interests, value, isInterestValue);
      },
      addCertification(value) {
        const record = certificationRecord(value);
        if (!record.name) return "ignored";
        return addKeyed(certifications, certificationKey(record), record, []);
      },
      addAbout(value) {
        const text = cleanText(value);
        // The longest read wins: a truncated "…see more" render must not beat the
        // expanded text, and neither may an empty later read erase it.
        if (text.length > about.length) about = text;
        return about;
      },
      addIdentity(patch = {}) {
        const fallback = Number.isFinite(Number(patch.score)) ? Number(patch.score) : -1;
        for (const field of ["name", "headline", "location"]) {
          const value = cleanText(patch[field]);
          if (!value) continue;
          const score = Number.isFinite(Number(patch[`${field}Score`])) ? Number(patch[`${field}Score`]) : fallback;
          if (score > identity[`${field}Score`]) {
            identity[field] = value;
            identity[`${field}Score`] = score;
          }
        }
        return identity;
      },
      addPartialSection(name) {
        const key = normalizeKey(name);
        if (key) partialSections.add(key);
        return partialSections.size;
      },

      /** An address seen anywhere: a mailto:, the Contact info panel, or body text. */
      addEmail(value) {
        const email = normalizeEmail(value);
        if (!email || emails.has(email)) return "ignored";
        emails.set(email, email);
        return "added";
      },
      addPhone(value) {
        const phone = normalizePhone(value);
        if (!phone) return "ignored";
        // Two renderings of one number ("+91 98765 43210" and "9876543210") are
        // the same number; the longer, more specific form is kept.
        for (const existing of phones.keys()) {
          if (existing.endsWith(phone) || phone.endsWith(existing)) {
            if (phone.length > existing.length) {
              phones.delete(existing);
              phones.set(phone, phone);
              return "merged";
            }
            return "ignored";
          }
        }
        phones.set(phone, phone);
        return "added";
      },
      addCvLink(value) {
        const url = cleanText(value);
        if (!url) return "ignored";
        const key = url.toLowerCase().replace(/\/+$/, "");
        if (cvLinks.has(key)) return "ignored";
        cvLinks.set(key, url);
        return "added";
      },
      addWebsite(value) {
        const text = cleanText(value);
        if (!text) return "ignored";
        const key = text.toLowerCase().replace(/\/+$/, "");
        if (websites.has(key)) return "ignored";
        websites.set(key, text);
        return "added";
      },
      /** Absorb a whole parsed Contact info panel in one call. */
      addContactPanel(panel = {}) {
        let added = 0;
        for (const value of panel.emails || []) if (this.addEmail(value) === "added") added += 1;
        for (const value of panel.phones || []) if (this.addPhone(value) !== "ignored") added += 1;
        for (const value of panel.cvLinks || []) if (this.addCvLink(value) === "added") added += 1;
        for (const value of panel.websites || []) if (this.addWebsite(value) === "added") added += 1;
        return added;
      },

      experience: () => [...experience.values()],
      /**
       * One entry per institution, named, in the order they were first read.
       *
       * The bare institution name is what the table's Education cell leads with
       * and what a search matches on. Everything else the card carried — the
       * degree, the field, the dates, the details — is kept too, on
       * `educationEntries()` below, so nothing read from the page is discarded.
       */
      education: () => uniqueText(
        groupEducationByInstitution([...education.values()]).map((record) => cleanText(record.institution)).filter(Boolean)
      ),
      /** The whole of every education card, one readable line each. */
      educationEntries: () => uniqueText(
        groupEducationByInstitution([...education.values()]).map(describeEducationRecord).filter(Boolean)
      ),
      /**
       * The whole of every role, one readable line each, grouped by company so a
       * promotion inside one organization reads as two roles there rather than
       * as two unrelated jobs.
       */
      experienceEntries: () => uniqueText(
        groupExperienceByCompany([...experience.values()])
          .flatMap((group) => group.roles.map(describeExperienceRecord))
          .filter(Boolean)
      ),
      skills: () => [...skills.values()],
      interests: () => [...interests.values()],
      certifications: () => [...certifications.values()].map(formatCertification).filter(Boolean),
      languages: () => [...languages.values()],
      partialSections: () => [...partialSections],
      emails: () => [...emails.values()],
      phones: () => [...phones.values()],
      cvLinks: () => [...cvLinks.values()],
      websites: () => [...websites.values()],
      get about() { return about; },
      get identity() { return { ...identity }; },

      counts() {
        return {
          experience: experience.size,
          education: education.size,
          skills: skills.size,
          certifications: certifications.size,
          languages: languages.size,
          interests: interests.size,
          emails: emails.size,
          phones: phones.size,
          cvLinks: cvLinks.size,
          websites: websites.size
        };
      },

      /** Fingerprint of everything captured so far; drives the scan's quiet count. */
      signature() {
        const counts = this.counts();
        return [
          about.length,
          identity.name.length,
          identity.headline.length,
          identity.location.length,
          counts.experience,
          counts.education,
          counts.skills,
          counts.certifications,
          counts.languages,
          // A late-hydrating Interests block is real page change: without it in
          // the fingerprint the scan can call the page settled before the last
          // section on it has rendered at all.
          counts.interests,
          counts.emails,
          counts.phones,
          counts.cvLinks,
          counts.websites,
          partialSections.size
        ].join(":");
      }
    };
  }

  const api = {
    PROFILE_SCAN, createScanState, nextScanStep,
    experienceKey, educationKey, skillKey, certificationKey,
    certificationRecord, formatCertification, mergeEntityRecords,
    groupEducationByInstitution, createProfileAccumulator,
    stripEntityMeta, isEmploymentMeta, sanitizeCompanyName, sanitizeRoleTitle, isSkillValue,
    isInterestValue, SKILL_CONTROL_PATTERN, SECTION_LABEL_PATTERN,
    // Who the page is about: the member's own URL is the one identifier a
    // re-render cannot move, so a name candidate is checked against it.
    looksLikeOrganizationName, profileSlugTokens, nameSlugAgreement,
    // The readable forms — what the table, the details panel and the CSV show.
    describeExperienceRecord, describeEducationRecord,
    cleanText, normalizeKey, comparisonKey, collapseRepeatedText, isNoiseText, uniqueText, cleanEntityLines,
    canonicalizeProfileUrl, splitName, looksLikeDateRange, looksLikeLocation, isEmploymentType,
    splitCompanyEmployment, splitDateDetails, splitLocationDetails, parseExperienceLines, formatExperience,
    parseFormattedExperience, parseExperienceGroup, groupExperienceByCompany, formatExperienceGroup,
    parseEducationLines, formatEducation, parseDateRange, calculateTotalExperience,
    // Contact reachability and the CV — the fields this release is led by.
    EMAIL_PATTERN, PHONE_PATTERN, CV_LABEL_PATTERN, DOCUMENT_URL_PATTERN, DOCUMENT_HOST_PATTERN,
    RESUME_HOST_PATTERN, LINKEDIN_URL_PATTERN, URL_TEXT_PATTERN, unwrapRedirectUrl,
    normalizeEmail, normalizePhone, extractEmails, extractPhones,
    CONTACT_FIELD_LABELS, readContactLabelLine, scanLabelledContacts,
    looksLikeCvLink, classifyContactLink, parseContactPanel, calculateExperienceYears,
    // Open to work — what the member is looking for, from their own panel.
    OPEN_TO_WORK_FIELDS, looksOpenToWork, parseOpenToWorkPanel, formatOpenToWork,
    // The Contact info overlay has to be given time to load before it is read.
    CONTACT_OVERLAY, createContactOverlayState, nextContactOverlayStep
  };

  globalThis.ProfileVaultCore = api;
})();
