import { namedFlavor } from '@protomaps/basemaps';

/**
 * Occu-Med Terrain color system derived from the licensed Outdoors-based
 * style export. Protomaps supplies the complete open basemap layer logic;
 * this object supplies the Occu-Med visual language.
 */
export const OCCUMED_FLAVOR = {
  ...namedFlavor('light'),

  regular: 'Noto Sans Regular',
  bold: 'Noto Sans Bold',
  italic: 'Noto Sans Italic',

  background: 'hsl(60, 20%, 85%)',
  earth: 'hsl(60, 20%, 85%)',
  water: 'hsl(205, 75%, 70%)',
  ocean_label: 'hsl(205, 45%, 36%)',

  park_a: 'hsl(98, 55%, 70%)',
  park_b: 'hsl(98, 38%, 68%)',
  wood_a: 'hsla(103, 50%, 60%, 0.8)',
  wood_b: 'hsl(98, 48%, 67%)',
  scrub_a: 'hsla(98, 47%, 68%, 0.6)',
  scrub_b: 'hsla(98, 50%, 74%, 0.6)',
  glacier: 'hsl(205, 45%, 95%)',
  sand: 'hsl(69, 60%, 72%)',
  beach: 'hsl(69, 60%, 76%)',

  hospital: 'hsl(20, 45%, 82%)',
  school: 'hsl(40, 45%, 78%)',
  industrial: 'hsl(230, 20%, 85%)',
  military: 'hsl(340, 30%, 82%)',
  zoo: 'hsl(98, 38%, 68%)',
  aerodrome: 'hsl(230, 40%, 82%)',
  runway: 'hsl(230, 36%, 74%)',
  pedestrian: 'hsl(55, 45%, 88%)',
  pier: 'hsl(60, 20%, 85%)',
  buildings: 'hsl(50, 15%, 75%)',

  highway: 'hsl(28, 82%, 68%)',
  major: 'hsl(48, 82%, 76%)',
  link: 'hsl(38, 82%, 70%)',
  minor_a: 'hsl(60, 20%, 96%)',
  minor_b: 'hsl(55, 70%, 88%)',
  minor_service: 'hsl(60, 18%, 94%)',
  other: 'hsl(60, 12%, 91%)',
  railway: 'hsl(260, 12%, 58%)',

  highway_casing_early: 'hsl(45, 20%, 68%)',
  highway_casing_late: 'hsl(45, 25%, 58%)',
  major_casing_early: 'hsl(45, 18%, 72%)',
  major_casing_late: 'hsl(45, 20%, 62%)',
  link_casing: 'hsl(45, 20%, 68%)',
  minor_casing: 'hsl(60, 8%, 76%)',
  minor_service_casing: 'hsl(60, 8%, 80%)',

  tunnel_highway: 'hsl(28, 56%, 82%)',
  tunnel_major: 'hsl(48, 45%, 86%)',
  tunnel_link: 'hsl(38, 45%, 84%)',
  tunnel_minor: 'hsl(60, 12%, 94%)',
  tunnel_other: 'hsl(60, 10%, 92%)',
  tunnel_highway_casing: 'hsl(60, 3%, 57%)',
  tunnel_major_casing: 'hsl(60, 3%, 62%)',
  tunnel_link_casing: 'hsl(60, 3%, 62%)',
  tunnel_minor_casing: 'hsl(60, 3%, 70%)',
  tunnel_other_casing: 'hsl(60, 3%, 72%)',

  bridges_highway: 'hsl(28, 82%, 68%)',
  bridges_major: 'hsl(48, 82%, 76%)',
  bridges_link: 'hsl(38, 82%, 70%)',
  bridges_minor: 'hsl(60, 20%, 96%)',
  bridges_other: 'hsl(60, 12%, 91%)',
  bridges_highway_casing: 'hsl(45, 25%, 58%)',
  bridges_major_casing: 'hsl(45, 20%, 62%)',
  bridges_link_casing: 'hsl(45, 20%, 68%)',
  bridges_minor_casing: 'hsl(60, 8%, 76%)',
  bridges_other_casing: 'hsl(60, 8%, 80%)',

  boundaries: 'hsl(230, 24%, 55%)',

  roads_label_major: 'hsl(60, 8%, 30%)',
  roads_label_major_halo: 'hsl(60, 20%, 96%)',
  roads_label_minor: 'hsl(60, 8%, 38%)',
  roads_label_minor_halo: 'hsl(60, 20%, 96%)',
  address_label: 'hsl(60, 8%, 42%)',
  address_label_halo: 'hsl(60, 20%, 96%)',
  subplace_label: 'hsl(60, 8%, 35%)',
  subplace_label_halo: 'hsl(60, 20%, 96%)',
  city_label: 'hsl(60, 8%, 24%)',
  city_label_halo: 'hsl(60, 20%, 97%)',
  state_label: 'hsl(230, 18%, 38%)',
  state_label_halo: 'hsl(60, 20%, 96%)',
  country_label: 'hsl(230, 22%, 30%)'
};
