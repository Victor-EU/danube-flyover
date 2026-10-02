// The card illustrations' viewpoints, shared by the renderer (src/record.ts, ?record=cards)
// and tools/cards.ts, which describes their hour to the image API.

/**
 * Where each card's picture is taken from: the compass direction from the landmark to the
 * camera, its distance and height above the aim point (metres), the clock and the field of
 * view. Bridges and the floodlit riverfront are shown by night, the hills by day, Parliament
 * at golden hour.
 */
export const CARD_VIEWS: Record<string, [azimuth: number, distance: number, height: number, time: number, fov: number]> = {
  japaneseGarden: [200, 130, 85, 17.3, 50],
  margaretBridge: [200, 380, 30, 17.7, 50],
  parliament: [245, 340, 10, 17.97, 45],
  shoes: [250, 9, 2.2, 18.0, 60],
  academy: [250, 210, 28, 17.6, 45],
  gresham: [235, 260, 12, 17.8, 45],
  chainBridge: [355, 250, -14, 19.7, 55],
  bastion: [75, 240, 25, 13.2, 50],
  matthias: [115, 170, 30, 13.2, 50],
  palace: [70, 520, -20, 19.95, 45],
  vigado: [260, 300, 0, 19.9, 45],
  elisabethBridge: [330, 260, 18, 16.6, 55],
  citadella: [150, 190, 80, 16.2, 50],
  libertyStatue: [75, 90, 0, 18.1, 50],
  gellertHotel: [45, 230, 18, 10.5, 50],
  libertyBridge: [335, 290, -2, 17.8, 50],
  marketHall: [315, 260, 45, 17.6, 50],
};
