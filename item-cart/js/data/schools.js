// School data model.
// WHAT: every school Item cart serves, keyed by id.
// WHY: Product/Vendor records reference schoolId, so adding a new
// school later (LAUTECH, OAU, UI...) is one new object here — no
// component, class name, or copy anywhere references "uniosun" directly.
// FUTURE: this becomes a `GET /schools` API response.

export const schools = [
  {
    id: "uniosun",
    name: "Osun State University",
    abbreviation: "UNIOSUN",
    location: "Osogbo, Osun State",
    active: true,
  },
];

// The school currently being served. Hard-coded to the one active
// school for now; a real multi-school build would replace this with
// an actual selection step (e.g. read from the URL, a subdomain, or a
// saved preference) once more than one school exists.
export const CURRENT_SCHOOL_ID = "uniosun";

export function getCurrentSchool() {
  return schools.find((school) => school.id === CURRENT_SCHOOL_ID);
}

export function getSchoolById(id) {
  return schools.find((school) => school.id === id);
}
