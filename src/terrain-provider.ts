import Cesium, {
  Cartographic,
  Rectangle,
  Ellipsoid,
  WebMercatorTilingScheme,
  TerrainProvider,
  Math as CMath,
  Event as CEvent,
  Cartesian3,
  BoundingSphere,
  QuantizedMeshTerrainData,
  HeightmapTerrainData,
  CesiumTerrainProvider,
  Credit
} from "cesium"
import OrientedBoundingBox from "cesium/Source/Core/OrientedBoundingBox"
import ndarray from 'ndarray'
import getPixels from 'get-pixels'
import Martini from '@mapbox/martini'

// Function stolen to rewind a ring
// https://github.com/mapbox/geojson-rewind/blob/master/index.js
function rewindRing(ring, dir) {
    var area = 0;
    for (var i = 0, len = ring.length, j = len - 1; i < len; j = i++) {
        area += (ring[i][0] - ring[j][0]) * (ring[j][1] + ring[i][1]);
    }
    if (area <= 0) ring.reverse();
    return ring
}

function mapboxTerrainToGrid(png: ndarray<number>) {
    const gridSize = png.shape[0] + 1;
    const terrain = new Float32Array(gridSize * gridSize);
    const tileSize = png.shape[0];

    // decode terrain values
    for (let y = 0; y < tileSize; y++) {
        for (let x = 0; x < tileSize; x++) {
            const yc = y
            const r = png.get(yc,x,0);
            const g = png.get(yc,x,1);
            const b = png.get(yc,x,2);
            terrain[y * gridSize + x] = (r * 256 * 256 + g * 256.0 + b) / 10.0 - 10000.0;
        }
    }
    // backfill right and bottom borders
    for (let x = 0; x < gridSize - 1; x++) {
      terrain[gridSize * (gridSize - 1) + x] = terrain[gridSize * (gridSize - 2) + x];
    }
    for (let y = 0; y < gridSize; y++) {
      terrain[gridSize * y + gridSize - 1] = terrain[gridSize * y + gridSize - 2];
    }
    return terrain;
}

// https://github.com/CesiumGS/cesium/blob/1.68/Source/Scene/MapboxImageryProvider.js#L42

class MapboxTerrainProvider {
  martini: any
  hasWaterMask = false
  hasVertexNormals = false
  credit = new Credit("Mapbox")
  ready: boolean
  readyPromise: Promise<boolean>
  availability = null
  errorEvent = new CEvent()
  tilingScheme: TerrainProvider["tilingScheme"]
  ellipsoid: Ellipsoid
  //_shadow?: CesiumTerrainProvider

  // @ts-ignore
  constructor(opts) {

    //this.martini = new Martini(257);
    this.martini = new Martini(257)
    this.ready = true
    this.readyPromise = Promise.resolve(true)

    this.errorEvent.addEventListener(console.log, this);
    this.ellipsoid = Ellipsoid.WGS84

    this.tilingScheme = new WebMercatorTilingScheme({
      numberOfLevelZeroTilesX: 1,
      numberOfLevelZeroTilesY: 1,
      ellipsoid: this.ellipsoid
    })

    //this._shadow = new CesiumTerrainProvider(opts)
  }

  async getPixels(url: string, type=""): Promise<ndarray<number>> {
    return new Promise((resolve, reject)=>{
      getPixels(url, type, (err, array)=>{
        if (err != null) reject(err)
        resolve(array)
      })
    })
  }

  async requestMapboxTile (x, y, z) {
    const access_token = process.env.MAPBOX_API_TOKEN
    const mx = this.tilingScheme.getNumberOfYTilesAtLevel(z)
    const err = this.getLevelMaximumGeometricError(z)


    // Something wonky about our tiling scheme, perhaps
    // 12/2215/2293 @2x
    const url =  `https://api.mapbox.com/v4/mapbox.terrain-rgb/${z}/${x}/${y}.pngraw?access_token=${access_token}`

    try {
      const pxArray = await this.getPixels(url)

      const terrain = mapboxTerrainToGrid(pxArray)

      // set up mesh generator for a certain 2^k+1 grid size
      // generate RTIN hierarchy from terrain data (an array of size^2 length)
      const tile = this.martini.createTile(terrain);

      // get a mesh (vertices and triangles indices) for a 10m error
      console.log(`Error level: ${err}`)
      const mesh = tile.getMesh(err);

      const terrainTile = await this.createQuantizedMeshData(x, y, z, tile, mesh)
      console.log(terrainTile)
      return terrainTile

    } catch(err) {
      console.log(err)
      const v = Math.max(32-4*z, 4)
      return this.emptyHeightmap(v)
    }
  }

  emptyHeightmap(samples) {
    return new HeightmapTerrainData({
      buffer: new Uint8Array(Array(samples*samples).fill(0)),
      width: samples,
      height: samples
    })
  }

  async createQuantizedMeshData (x, y, z, tile, mesh) {
    const err = this.getLevelMaximumGeometricError(z)
    const skirtHeight = err*5

    const tileRect = this.tilingScheme.tileXYToRectangle(x, y, z)
    //const tileNativeRect = this.tilingScheme.tileXYToNativeRectangle(x, y, z)
    const tileCenter = Cartographic.toCartesian(Rectangle.center(tileRect))
    const horizonOcclusionPoint = Ellipsoid.WGS84.transformPositionToScaledSpace(
      tileCenter
    )

    let boundingSphere = new BoundingSphere(
      Cartesian3.ZERO,
      // radius
      6379792.481506292
    )

    const xvals = []
    const yvals = []
    const heightMeters = []
    const northIndices = []
    const southIndices = []
    const eastIndices = []
    const westIndices = []


    for (let ix = 0; ix < mesh.vertices.length/2; ix++) {
      const vertexIx = ix
      const px = mesh.vertices[ix*2]
      const py = mesh.vertices[ix*2+1]
      heightMeters.push(tile.terrain[py*256+px])

      if (py == 0) northIndices.push(vertexIx)
      if (py == 256) southIndices.push(vertexIx)
      if (px == 0) westIndices.push(vertexIx)
      if (px == 256) eastIndices.push(vertexIx)

      let xv = Math.min(px*128,32767)
      let yv = Math.min((256-py)*128,32767)

      xvals.push(xv)
      yvals.push(yv)
    }

    const maxHeight = Math.max.apply(this, heightMeters)
    const minHeight = Math.min.apply(this, heightMeters)




    console.log(minHeight, maxHeight, heightMeters)

    const heights = heightMeters.map(d =>{
      if (maxHeight-minHeight < 1) return 0
      return (d-minHeight)*(32767/(maxHeight-minHeight))
    })

    let orientedBoundingBox = null


    if (tileRect.width < CMath.PI_OVER_TWO + CMath.EPSILON5) {
      // @ts-ignore
      orientedBoundingBox = OrientedBoundingBox.fromRectangle(tileRect, minHeight, maxHeight)
      // @ts-ignore
      boundingSphere = BoundingSphere.fromOrientedBoundingBox(orientedBoundingBox)
    }


    const triangles = new Uint16Array(mesh.triangles)
    // function shouldRewind(indices) {
    //     var area = 0;
    //     for (var i = 0, len = indices.length, j = len - 1; i < len; j = i++) {
    //       const ixi = indices[i]
    //       const ixj = indices[j]
    //       area += (xvals[ixi] - xvals[ixj]) * (yvals[ixj] + yvals[ixi]);
    //     }
    //     return area >= 0
    // }
    //
    // for (let ix = 0; ix < mesh.triangles.length/3; ix++) {
    //   const startIx = ix*3
    //   // triangles[startIx] = mesh.triangles[startIx+1]
    //   // triangles[startIx+1] = mesh.triangles[startIx+2]
    //   // triangles[startIx+2] = mesh.triangles[startIx]
    //   const rewind = shouldRewind(mesh.triangles.subarray(startIx, startIx+3))
    //   if (!rewind) {
    //     triangles[startIx] = mesh.triangles[startIx]
    //     triangles[startIx+1] = mesh.triangles[startIx+2]
    //     triangles[startIx+2] = mesh.triangles[startIx+1]
    //   }
    //
    // }

    // @ts-ignore

    if (z < 5) {
      return this.emptyHeightmap(32)
    }

    let verts = []
    xvals.forEach(function(x, i) {
      verts.push(x)
      verts.push(yvals[i])
      verts.push(heights[i])
    });

    console.log(verts)

    const quantizedVertices = new Uint16Array(
      //verts
      [...xvals, ...yvals, ...heights]
    )

    // SE NW NE
    // NE NW SE

    console.log(quantizedVertices, triangles)

    return new QuantizedMeshTerrainData({
      minimumHeight: Math.max(minHeight, 0),
      maximumHeight: Math.max(maxHeight, 0),
      quantizedVertices,
      indices : triangles,
      // @ts-ignore
      boundingSphere,
      // @ts-ignore
      orientedBoundingBox,
      // @ts-ignore
      horizonOcclusionPoint,
      westIndices,
      southIndices,
      eastIndices,
      northIndices,
      westSkirtHeight : skirtHeight,
      southSkirtHeight : skirtHeight,
      eastSkirtHeight : skirtHeight,
      northSkirtHeight : skirtHeight,
      //childTileMask: 15
    })
  }

  async requestTileGeometry (x, y, z) {
    try {
      const mapboxTile = await this.requestMapboxTile(x,y,z)
      return mapboxTile
    } catch(err) {
      console.log(err)
    }
    //if (z > 10) debugger
  }

  getLevelMaximumGeometricError (level) {
    const levelZeroMaximumGeometricError = TerrainProvider
      .getEstimatedLevelZeroGeometricErrorForAHeightmap(
        this.tilingScheme.ellipsoid,
        65,
        this.tilingScheme.getNumberOfXTilesAtLevel(0)
      )

    return levelZeroMaximumGeometricError / (1 << level)
  }

  getTileDataAvailable(x, y, z) {
    return z <= 15
  }
}

class TestTerrainProvider extends CesiumTerrainProvider {
  mapboxProvider = new MapboxTerrainProvider({})
  async requestTileGeometry (x, y, z) {
    const tile = await super.requestTileGeometry(x,y,z)
    //const mapboxTile = await this.mapboxProvider.requestTileGeometry(x,y,z+1)
    console.log(tile)//, mapboxTile)
    //if (z > 10) debugger
    return tile
  }
}

export default MapboxTerrainProvider
