"use client";

import { useEffect, useId, useState } from "react";
import { countries, type Country } from "@/lib/countries";
import { FILTER_KEYS, type BrowseFilters } from "@/lib/browse-filters";

export interface Category {
  id: string;
  slug: string;
  name: string;
}

/**
 * The four things you can narrow the list by — screen 2.1, issue #166.
 *
 * Exactly the API's four, and no more: two countries, a category and a text
 * search. The design shows no sort control and the API has no sort to offer —
 * the list is newest first, always.
 *
 * The categories are passed in rather than fetched here. The page already has
 * a loading state and a failure state; a second request living inside this
 * component would grow it a second set of both, for a select that can simply
 * be empty until the list arrives.
 */
export function NeedFilters({
  filters,
  categories,
  onChange,
  onSubmit,
}: {
  filters: BrowseFilters;
  categories: Category[];
  /** While typing: the caller decides this only replaces the history entry. */
  onChange: (next: BrowseFilters) => void;
  /** A filter applied, or the search submitted: worth a history entry. */
  onSubmit: (next: BrowseFilters) => void;
}) {
  const ids = useId();

  /**
   * THE COUNTRY NAMES ARE BUILT AFTER MOUNT, and that is measured rather than
   * precautionary. Node and Chrome ship different ICU data, so
   * `Intl.DisplayNames` disagrees with itself across the two: `FK` is
   * "Falkland Islands" when this page is prerendered and "Falkland Islands
   * (Islas Malvinas)" once it hydrates. React throws the whole tree away over
   * that difference, and the console says so.
   *
   * The select is on screen from the first paint with its "anywhere" choice;
   * the 249 names arrive a tick later, which nobody about to pick a country
   * will notice. Shipping our own names instead would be 249 strings to
   * maintain in place of one browser API, and #156 decided against that.
   */
  const [named, setNamed] = useState<Country[]>([]);

  useEffect(() => {
    setNamed(countries());
  }, []);

  /**
   * A cleared control sends nothing, so an empty value removes the key.
   *
   * Rebuilt rather than deleted from: with `exactOptionalPropertyTypes`,
   * "absent" is the only way to be absent, and an entry rebuilt from the ones
   * that are set cannot leave an explicit `undefined` behind.
   */
  function set(key: keyof BrowseFilters, value: string): BrowseFilters {
    const next: BrowseFilters = {};

    for (const name of FILTER_KEYS) {
      const existing = filters[name];
      if (name !== key && existing !== undefined) next[name] = existing;
    }

    if (value !== "") next[key] = value;

    return next;
  }

  return (
    <form
      className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(filters);
      }}
    >
      <div className="lg:col-span-2">
        <label className="sr-only" htmlFor={`${ids}-q`}>
          Search what people need
        </label>
        <input
          id={`${ids}-q`}
          className="input w-full"
          type="search"
          placeholder="Search by name or description"
          value={filters.q ?? ""}
          /*
            TYPING IS NOT NAVIGATION. `onChange` replaces the history entry;
            only applying a filter or submitting pushes one. Otherwise Back
            walks the person through "s", "su", "sun" before leaving the page.
          */
          onChange={(event) => {
            onChange(set("q", event.target.value));
          }}
        />
      </div>

      <div>
        <label className="sr-only" htmlFor={`${ids}-buy`}>
          Bought in
        </label>
        <select
          id={`${ids}-buy`}
          className="input w-full"
          value={filters.buyCountry ?? ""}
          onChange={(event) => {
            onSubmit(set("buyCountry", event.target.value));
          }}
        >
          <option value="">Bought anywhere</option>
          {named.map((country) => (
            <option key={country.code} value={country.code}>
              {country.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="sr-only" htmlFor={`${ids}-deliver`}>
          Delivered to
        </label>
        <select
          id={`${ids}-deliver`}
          className="input w-full"
          value={filters.deliverCountry ?? ""}
          onChange={(event) => {
            onSubmit(set("deliverCountry", event.target.value));
          }}
        >
          <option value="">Delivered anywhere</option>
          {named.map((country) => (
            <option key={country.code} value={country.code}>
              {country.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-3 lg:col-span-4">
        <label className="sr-only" htmlFor={`${ids}-category`}>
          Category
        </label>
        <select
          id={`${ids}-category`}
          className="input"
          value={filters.categoryId ?? ""}
          onChange={(event) => {
            onSubmit(set("categoryId", event.target.value));
          }}
        >
          <option value="">Every category</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>

        <button type="submit" className="btn btn-secondary">
          Search
        </button>

        {/*
          Only when there is something to clear, and it goes back to the plain
          URL. This is also the way out of 2.1b, which is the state that needs
          one most.
        */}
        {Object.keys(filters).length > 0 && (
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => {
              onSubmit({});
            }}
          >
            Clear
          </button>
        )}
      </div>
    </form>
  );
}
