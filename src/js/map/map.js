import {
  areEqual,
  isNotNullNorUndefined
} from '../data/utilities';
import hash from 'object-hash';
import 'leaflet-polylinedecorator';

export default function(newApp, ui, select) {
  let svg, g, defs;

  let categoryColorGroups = {};

  const domain = {
    locations: [],
    narratives: [],
    categoryGroups: [],
    sites: []
  }
  const app = {
    selected: [],
    highlighted: null,
    views: Object.assign({}, newApp.views),
  }

  const getCategoryGroup = newApp.getCategoryGroup;
  const getCategoryGroupColor = newApp.getCategoryGroupColor;
  const groupColors = ui.style.groupColors;

    // Map Settings
  const center = newApp.mapAnchor;
  const maxBoundaries = [[180, -180], [-180, 180]];
  const zoomLevel = 14;

  // Initialize layer
  const sitesLayer = L.layerGroup();
  const pathLayer = L.layerGroup();

  // Icons for markPoint flags (a yellow ring around a location)
  const eventCircleMarkers = {};

  // Styles for elements in map
  const settingsSiteLabel = {
    className: 'site-label',
    opacity: 1,
    permanent: true,
    direction: 'top',
  };


  /**
   * Creates a Leaflet map and a tilelayer for the map background
   * @param {string} id: DOM element to create map onto
   * @param {array} center: [lat, long] coordinates the map will be centered on
   * @param {number} zoom: zoom level
   */
  function initBackgroundMap(id, zoom) {
    /* http://bl.ocks.org/sumbera/10463358 */

    const map = L.map(id)
      .setView(center, zoom)
      .setMinZoom(10)
      .setMaxZoom(18)
      .setMaxBounds(maxBoundaries);

    // NB: configure tile endpoint
    let s;
    if (process.env.MAPBOX_TOKEN) {
      s = L.tileLayer(
        `http://a.tiles.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}@2x.png?access_token=${process.env.MAPBOX_TOKEN}`
      );
    } else {
      s = L.tileLayer(`${process.env.SERVER_ROOT}/mapbox/{z}/{x}/{y}`);
    }
    s = s.addTo(map);

    map.keyboard.disable();
    const pane = d3.select(map.getPanes().overlayPane);
    const boundingClient = d3.select(`#${id}`).node().getBoundingClientRect();
    const width = boundingClient.width;
    const height = boundingClient.height;

    svg = pane.append('svg')
      .attr('class', 'leaflet-svg')
      .attr('width', width)
      .attr('height', height);

    g = svg.append('g');

    svg.insert('defs', 'g')
      .append('marker')
      .attr('id', 'arrow')
      .attr('viewBox', '0 0 6 6')
      .attr('refX', 3)
      .attr('refY', 3)
      .attr('markerWidth', 14)
      .attr('markerHeight', 14)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,3v-3l6,3l-6,3z');

    map.on('zoomstart', () => {
      svg.classed('hide', true);
    });
    map.on('zoomend', () => {
      svg.classed('hide', false);
    });

    return map;
  }

  // Initialize leaflet map and layers for each type of data
  const lMap = initBackgroundMap(ui.dom.map, zoomLevel);

  function projectPoint(location) {
    const latLng = new L.LatLng(location[0], location[1]);
    return lMap.latLngToLayerPoint(latLng);
  }

  function getSVGBoundaries() {
    return {
      topLeft: projectPoint(maxBoundaries[0]),
      bottomRight: projectPoint(maxBoundaries[1])
    }
  }

  function updateSVG() {
    const boundaries = getSVGBoundaries();
    const {
      topLeft,
      bottomRight
    } = boundaries;
    svg.attr('width', bottomRight.x - topLeft.x + 200)
      .attr('height', bottomRight.y - topLeft.y + 200)
      .style('left', `${topLeft.x - 100}px`)
      .style('top', `${topLeft.y - 100}px`);

    g.attr('transform', `translate(${-(topLeft.x - 100)},${-(topLeft.y - 100)})`);

    g.selectAll('.location').attr('transform', (d) => {
      const newPoint = projectPoint([+d.latitude, +d.longitude]);
      return `translate(${newPoint.x},${newPoint.y})`;
    });

    g.selectAll('.narrative')
      .attr('d', sequenceLine);

    const busLine = d3.line()
      .x(d => lMap.latLngToLayerPoint(d).x)
      .y(d => lMap.latLngToLayerPoint(d).y)
      .curve(d3.curveMonotoneX);
  }

  lMap.on("zoom viewreset move", updateSVG);

  /**
   * Returns latitud / longitude
   * @param {Object} eventPoint: data for an evenPoint - time, loc, tags, etc
   */
  function getEventLocation(eventPoint) {
    return {
      latitude: +eventPoint.location.latitude,
      longitude: +eventPoint.location.longitude,
    };
  }

  /*
   * INTERACTIVE FUNCTIONS
   */

  /**
   * Removes the circular ring to mark a particular location
   */
  function unmarkPoint() {
    Object.keys(eventCircleMarkers).forEach(markerId => {
      lMap.removeLayer(eventCircleMarkers[markerId]);
      delete eventCircleMarkers[markerId];
    });
  }

  /**
   * Makes a circular ring mark in one particular location at a time
   * @param {object} location object, with lat and long
   */
  function renderSelected() {
    unmarkPoint();
    app.selected.forEach(eventPoint => {
      if (isNotNullNorUndefined(eventPoint) && isNotNullNorUndefined(eventPoint.location)) {
        if (eventPoint.latitude && eventPoint.longitude) {
          const location = new L.LatLng(eventPoint.latitude, eventPoint.longitude);
          eventCircleMarkers[eventPoint.id] = L.circleMarker(location, {
            radius: 32,
            fill: false,
            color: '#ffffff',
            weight: 3,
            lineCap: '',
            dashArray: '5,2'
          });
          eventCircleMarkers[eventPoint.id].addTo(lMap);
        }
      }
    })
  }

  function renderHighlighted() {
    // Fly to first of events selected
    const eventPoint = (app.selected.length > 0) ? app.selected[0] : null;
    if (isNotNullNorUndefined(eventPoint) && isNotNullNorUndefined(eventPoint.location)) {
      if (eventPoint.latitude && eventPoint.longitude) {
        const location = new L.LatLng(eventPoint.latitude, eventPoint.longitude);
        lMap.flyTo(location);
      }
    }
  }

  /*
   * RENDERING FUNCTIONS
   */

  function getLocationEventsDistribution(location) {
    const eventsHere = {};
    const categoryGroups = domain.categoryGroups;
    categoryGroups.sort((a, b) => {
      return (+a.slice(-2) > +b.slice(-2));
    });
    categoryGroups.forEach(group => {
      eventsHere[group] = 0
    });

    location.events.forEach((event) => {
      const group = getCategoryGroup(event.category);
      eventsHere[group] += 1;
    });

    let i = 0;
    const events = [];

    while (i < categoryGroups.length) {
      let eventsCount = eventsHere[categoryGroups[i]];
      for (let j = i + 1; j < categoryGroups.length; j++) {
        eventsCount += eventsHere[categoryGroups[j]];
      }
      events.push(eventsCount);
      i++;
    }

    return events;
  }

  /**
   * Clears existing event layer
   * Renders all events as markers
   * Adds eventlayer to map
   */
  function renderEvents() {
    const locationsDom = g.selectAll('.location')
      .data(domain.locations, d => d.id)

    locationsDom
      .exit()
      .remove();

    locationsDom
      .enter().append('g')
      .attr('class', 'location')
      .attr('transform', (d) => {
        d.LatLng = new L.LatLng(+d.latitude, +d.longitude);
        console.log(lMap.latLngToLayerPoint(d.LatLng))
        return `translate(${lMap.latLngToLayerPoint(d.LatLng).x},
                  ${lMap.latLngToLayerPoint(d.LatLng).y})`;
      })
      .on('click', (location) => {
        select(location.events);
      });

    const eventsDom = g.selectAll('.location').selectAll('.location-event-marker')
      .data((d, i) => getLocationEventsDistribution(domain.locations[i]),
        (d, i) => 'location-' + i);

    eventsDom
      .exit()
      .attr('r', 0)
      .remove();

    eventsDom
      .transition()
      .duration(500)
      .attr('r', d => (d) ? Math.sqrt(16 * d) + 3 : 0);

    eventsDom
      .enter().append('circle')
      .attr('class', 'location-event-marker')
      .style('fill', (d, i) => groupColors[domain.categoryGroups[i]])
      .transition()
      .duration(500)
      .attr('r', d => (d) ? Math.sqrt(16 * d) + 3 : 0);
  }

  // NB: is this a function to be removed for future features?
  function renderSites() {
    sitesLayer.clearLayers();
    lMap.removeLayer(sitesLayer);

    // Create a label for each attack site, persistent across filtering
    if (app.views.sites) {
      domain.sites.forEach((site) => {
        if (isNotNullNorUndefined(site)) {
          // Create an invisible marker for each site label
          const siteMarker = L.circleMarker([+site.latitude, +site.longitude], {
            radius: 0,
            stroke: 0
          });

          siteMarker.bindTooltip(site.site, settingsSiteLabel).openTooltip();

          // Add this one attack marker to group attack layer
          sitesLayer.addLayer(siteMarker);
        }
      });

      lMap.addLayer(sitesLayer);
    }
  }


   const getCoords = (d) => {
     d.LatLng = new L.LatLng(+d.latitude, +d.longitude);
     return {
       x: lMap.latLngToLayerPoint(d.LatLng).x,
       y: lMap.latLngToLayerPoint(d.LatLng).y
     }
   }

   const sequenceLine = d3.line()
     .x(d => getCoords(d).x)
     .y(d => getCoords(d).y)

   /**
    * Clears existing narrative layer
    * Renders all narrativ as paths
    * Adds eventlayer to map
    */

  function renderNarratives() {
    const narrativesDom = g.selectAll('.narrative')
      .data(domain.narratives.map(d => d.steps))

    narrativesDom
      .exit()
      .remove();

    narrativesDom
      .enter().append('path')
      .attr('class', 'narrative')
      .attr('d', sequenceLine)
      .style('stroke-width', 3)
      .style('stroke', '#fff')
      .style('fill', 'none');
  }

  /**
   * Updates displayable data on the map: events, coevents and paths
   * @param {Object} domain: object of arrays of events, coevs, attacks, paths, sites
   */
  function update(newDomain, newApp) {
    updateSVG();

    if (hash(domain) !== hash(newDomain)) {
      domain.locations = newDomain.locations;
      domain.narratives = newDomain.narratives;
      domain.categoryGroups = newDomain.categoryGroups;
      domain.sites = newDomain.sites;
      renderDomain();
    }

    if (hash(app) !== hash(newApp)) {
      app.selected = newApp.selected;
      app.highlighted = newApp.highlighted;
      app.views = newApp.views;

      renderSelectedAndHighlight();
    }
  }

  /**
   * Renders events on the map: takes data, and enters, updates and exits
   */
   function renderDomain () {
     renderSites();
     renderEvents();
     renderNarratives();
   }
  function renderSelectedAndHighlight () {
    renderSelected();
    renderHighlighted();
  }

  /**
   * Expose only relevant functions
   */
  return {
    update
  };
}
