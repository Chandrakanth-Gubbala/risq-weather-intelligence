export const regionCatalog = {
  northeast: {
    label: "Northeast U.S.",
    states: ["ME", "NH", "VT", "MA", "RI", "CT", "NY", "NJ", "PA"],
    anchors: [
      city("Boston", "MA", 42.3601, -71.0589),
      city("Rochester", "NY", 43.1566, -77.6088),
      city("New York", "NY", 40.7128, -74.006),
      city("Philadelphia", "PA", 39.9526, -75.1652),
      city("Portland", "ME", 43.6591, -70.2568)
    ]
  },
  southeast: {
    label: "Southeast U.S.",
    states: ["DE", "MD", "DC", "VA", "WV", "KY", "TN", "NC", "SC", "GA", "FL", "AL", "MS", "AR", "LA"],
    anchors: [city("Birmingham", "AL", 33.5186, -86.8104), city("Houston", "TX", 29.7604, -95.3698)]
  },
  midwest: {
    label: "Midwest U.S.",
    states: ["OH", "MI", "IN", "IL", "WI", "MN", "IA", "MO", "ND", "SD", "NE", "KS"],
    anchors: [city("Chicago", "IL", 41.8781, -87.6298), city("Minneapolis", "MN", 44.9778, -93.265)]
  },
  southwest: {
    label: "Southwest U.S.",
    states: ["AZ", "NM", "NV", "UT", "CO", "TX", "OK"],
    anchors: [city("Phoenix", "AZ", 33.4484, -112.074), city("Dallas", "TX", 32.7767, -96.797), city("Denver", "CO", 39.7392, -104.9903)]
  },
  northwest: {
    label: "Northwest U.S.",
    states: ["WA", "OR", "ID", "MT", "WY"],
    anchors: [city("Seattle", "WA", 47.6062, -122.3321), city("Portland", "OR", 45.5152, -122.6784), city("Boise", "ID", 43.615, -116.2023)]
  },
  west_coast: {
    label: "West Coast",
    states: ["CA", "OR", "WA"],
    anchors: [city("Los Angeles", "CA", 34.0522, -118.2437), city("San Francisco", "CA", 37.7749, -122.4194), city("Seattle", "WA", 47.6062, -122.3321)]
  },
  east_coast: {
    label: "East Coast",
    states: ["ME", "NH", "MA", "RI", "CT", "NY", "NJ", "DE", "MD", "DC", "VA", "NC", "SC", "GA", "FL"],
    anchors: [
      city("Portland", "ME", 43.6591, -70.2568),
      city("Boston", "MA", 42.3601, -71.0589),
      city("New York", "NY", 40.7128, -74.006),
      city("Philadelphia", "PA", 39.9526, -75.1652)
    ]
  },
  gulf_coast: {
    label: "Gulf Coast",
    states: ["TX", "LA", "MS", "AL", "FL"],
    anchors: [city("Houston", "TX", 29.7604, -95.3698), city("Birmingham", "AL", 33.5186, -86.8104)]
  },
  mountain_west: {
    label: "Mountain West",
    states: ["MT", "ID", "WY", "NV", "UT", "CO", "AZ", "NM"],
    anchors: [city("Denver", "CO", 39.7392, -104.9903), city("Phoenix", "AZ", 33.4484, -112.074)]
  },
  new_england: {
    label: "New England",
    states: ["ME", "NH", "VT", "MA", "RI", "CT"],
    anchors: [city("Boston", "MA", 42.3601, -71.0589), city("Portland", "ME", 43.6591, -70.2568)]
  },
  mid_atlantic: {
    label: "Mid-Atlantic",
    states: ["NY", "NJ", "PA", "DE", "MD", "DC", "VA", "WV"],
    anchors: [city("New York", "NY", 40.7128, -74.006), city("Philadelphia", "PA", 39.9526, -75.1652), city("Rochester", "NY", 43.1566, -77.6088)]
  },
  great_lakes: {
    label: "Great Lakes",
    states: ["MN", "WI", "IL", "IN", "MI", "OH", "PA", "NY"],
    anchors: [city("Rochester", "NY", 43.1566, -77.6088), city("Chicago", "IL", 41.8781, -87.6298)]
  },
  california: {
    label: "California",
    states: ["CA"],
    anchors: [city("Los Angeles", "CA", 34.0522, -118.2437), city("San Francisco", "CA", 37.7749, -122.4194)]
  },
  nationwide: {
    label: "Across the U.S.",
    states: null,
    anchors: [
      city("Boston", "MA", 42.3601, -71.0589),
      city("Rochester", "NY", 43.1566, -77.6088),
      city("New York", "NY", 40.7128, -74.006),
      city("Philadelphia", "PA", 39.9526, -75.1652),
      city("Portland", "ME", 43.6591, -70.2568),
      city("Houston", "TX", 29.7604, -95.3698),
      city("Dallas", "TX", 32.7767, -96.797),
      city("Birmingham", "AL", 33.5186, -86.8104),
      city("Denver", "CO", 39.7392, -104.9903),
      city("Phoenix", "AZ", 33.4484, -112.074)
    ]
  }
};

export const regionIds = Object.freeze(Object.keys(regionCatalog));

export const stateAnchorCatalog = {
  AL: [city("Birmingham", "AL", 33.5186, -86.8104)],
  AZ: [city("Phoenix", "AZ", 33.4484, -112.074)],
  CO: [city("Denver", "CO", 39.7392, -104.9903)],
  MA: [city("Boston", "MA", 42.3601, -71.0589)],
  ME: [city("Portland", "ME", 43.6591, -70.2568)],
  NY: [city("New York", "NY", 40.7128, -74.006), city("Rochester", "NY", 43.1566, -77.6088)],
  PA: [city("Philadelphia", "PA", 39.9526, -75.1652)],
  TX: [city("Houston", "TX", 29.7604, -95.3698), city("Dallas", "TX", 32.7767, -96.797)]
};

export function regionLabel(regionId) {
  return regionCatalog[regionId]?.label ?? null;
}

function city(name, state, lat, lon) {
  return { name, state, lat, lon };
}
