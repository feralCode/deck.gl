/* global fetch */

import {COORDINATE_SYSTEM, CompositeLayer} from '@deck.gl/core';
import {PointCloudLayer} from '@deck.gl/layers';
import {ScenegraphLayer} from '@deck.gl/mesh-layers';

import {parse} from '@loaders.gl/core';
import {GLTFLoader} from '@loaders.gl/gltf';
import {Tileset3D, _getIonTilesetMetadata} from '@loaders.gl/3d-tiles';

import {getFrameState} from './get-frame-state';

const defaultProps = {
  getColor: [255, 0, 0],
  _lighting: 'pbr',
  pointSize: 1.0,
  opacity: 1.0,

  tilesetUrl: null,
  _ionAssetId: null,
  _ionAccessToken: null,
  onTilesetLoad: tileset3d => {},
  onTileLoad: tileHeader => {},
  onTileUnload: tileHeader => {},
  onTileLoadFail: (tile, message, url) => {}
};

function unpackTile(tileHeader, dracoLoader) {
  const content = tileHeader.content;
  if (content) {
    switch (content.type) {
      case 'pnts':
        // Nothing to do;
        break;
      case 'i3dm':
      case 'b3dm':
        unpackGLTF(tileHeader, dracoLoader);
        break;
      default:
        throw new Error(`Tile3DLayer: Error unpacking 3D tile ${content.type}`);
    }
  }
}

// TODO - move glTF + Draco parsing into the Tile3DLoader
// DracoLoading is typically async on worker, better keep it in the top-level `parse` promise...
function unpackGLTF(tileHeader, dracoLoader) {
  if (tileHeader.content.gltfArrayBuffer) {
    tileHeader.userData.gltf = parse(tileHeader.content.gltfArrayBuffer, [GLTFLoader], {
      DracoLoader: dracoLoader,
      decompress: true
    });
  }
  if (tileHeader.content.gltfUrl) {
    tileHeader.userData.gltf = tileHeader.tileset.getTileUrl(tileHeader.content.gltfUrl);
  }
}

export default class Tile3DLayer extends CompositeLayer {
  initializeState() {
    this.state = {
      layerMap: {},
      tileset3d: null
    };
  }

  shouldUpdateState({changeFlags}) {
    return changeFlags.somethingChanged;
  }

  async updateState({props, oldProps}) {
    if (props.tilesetUrl && props.tilesetUrl !== oldProps.tilesetUrl) {
      await this._loadTileset(props.tilesetUrl);
    } else if (
      (props._ionAccessToken || props._ionAssetId) &&
      (props._ionAccessToken !== oldProps._ionAccessToken ||
        props._ionAssetId !== oldProps._ionAssetId)
    ) {
      await this._loadTilesetFromIon(props._ionAccessToken, props._ionAssetId);
    }

    const {tileset3d} = this.state;
    await this._updateTileset(tileset3d);
  }

  async _loadTileset(tilesetUrl, fetchOptions, ionMetadata) {
    const response = await fetch(tilesetUrl, fetchOptions);
    const tilesetJson = await response.json();

    const tileset3d = new Tileset3D(tilesetJson, tilesetUrl, {
      throttleRequests: true,
      onTileLoad: tileHeader => {
        this.props.onTileLoad(tileHeader);
        this._updateTileset(tileset3d);
        this.setNeedsUpdate();
      },
      onTileUnload: this.props.onTileUnload,
      onTileLoadFail: this.props.onTileLoadFail,
      // TODO: explicit passing should not be needed, registerLoaders should suffice
      DracoLoader: this._getDracoLoader(),
      fetchOptions,
      ...ionMetadata
    });

    this.setState({
      tileset3d,
      layerMap: {}
    });

    if (tileset3d) {
      this.props.onTilesetLoad(tileset3d);
    }
  }

  async _loadTilesetFromIon(ionAccessToken, ionAssetId) {
    const ionMetadata = await _getIonTilesetMetadata(ionAccessToken, ionAssetId);
    const {url, headers} = ionMetadata;
    return await this._loadTileset(url, {headers}, ionMetadata);
  }

  _updateTileset(tileset3d) {
    const {timeline, viewport} = this.context;
    if (!timeline || !viewport || !tileset3d) {
      return;
    }

    // use Date.now() as frame identifier for now and later used to filter layers for rendering
    const frameState = getFrameState(viewport, Date.now());
    tileset3d.update(frameState);
    this._updateLayerMap(frameState.frameNumber);
  }

  // `Layer` instances is created and added to the map if it doesn't exist yet.
  _updateLayerMap(frameNumber) {
    const {tileset3d, layerMap} = this.state;

    // create layers for new tiles
    const {selectedTiles} = tileset3d;
    const tilesWithoutLayer = selectedTiles.filter(tile => !layerMap[tile.fullUri]);

    for (const tile of tilesWithoutLayer) {
      // TODO - why do we call this here? Being "selected" should automatically add it to cache?
      tileset3d.addTileToCache(tile);
      unpackTile(tile, this._getDracoLoader());

      layerMap[tile.fullUri] = {
        layer: this._create3DTileLayer(tile),
        tile
      };
    }

    // update layer visibility
    this._selectLayers(frameNumber);
  }

  _getDracoLoader() {
    return this.props.DracoWorkerLoader || this.props.DracoLoader;
  }

  // Grab only those layers who were selected this frame.
  _selectLayers(frameNumber) {
    const {layerMap} = this.state;
    const layerMapValues = Object.values(layerMap);

    for (const value of layerMapValues) {
      const {tile} = value;
      let {layer} = value;

      if (tile.selectedFrame === frameNumber) {
        if (layer && layer.props && !layer.props.visible) {
          // Still has GPU resource but visibility is turned off so turn it back on so we can render it.
          layer = layer.clone({visible: true});
          layerMap[tile.fullUri].layer = layer;
        }
      } else if (tile.contentUnloaded) {
        // Was cleaned up from tileset cache. We no longer need to track it.
        delete layerMap[tile.fullUri];
      } else if (layer && layer.props && layer.props.visible) {
        // Still in tileset cache but doesn't need to render this frame. Keep the GPU resource bound but don't render it.
        layer = layer.clone({visible: false});
        layerMap[tile.fullUri].layer = layer;
      }
    }

    this.setState({layers: Object.values(layerMap).map(layer => layer.layer)});
  }

  _create3DTileLayer(tileHeader) {
    if (!tileHeader.content) {
      return null;
    }

    switch (tileHeader.content.type) {
      case 'pnts':
        return this._createPointCloudTileLayer(tileHeader);
      case 'i3dm':
      case 'b3dm':
        return this._create3DModelTileLayer(tileHeader);
      default:
        throw new Error(`Tile3DLayer: Failed to render layer of type ${tileHeader.content.type}`);
    }
  }

  _create3DModelTileLayer(tileHeader) {
    const {gltf} = tileHeader.userData;
    const {instances, cartographicOrigin, modelMatrix} = tileHeader.content;

    const SubLayerClass = this.getSubLayerClass('scenegraph', ScenegraphLayer);

    const {_lighting} = this.props;
    return new SubLayerClass(
      {
        _lighting
      },
      this.getSubLayerProps({
        id: 'scenegraph'
      }),
      {
        id: `${this.id}-scenegraph-${tileHeader.fullUri}`,
        // Fix for ScenegraphLayer.modelMatrix, under flag in deck 7.3 to avoid breaking existing code
        data: instances || [{}],
        scenegraph: gltf,

        coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
        coordinateOrigin: cartographicOrigin,
        modelMatrix,
        _composeModelMatrix: true,
        getTransformMatrix: instance => instance.modelMatrix,
        getPosition: instance => [0, 0, 0]
      }
    );
  }

  _createPointCloudTileLayer(tileHeader) {
    const {
      attributes,
      pointCount,
      constantRGBA,
      cartographicOrigin,
      modelMatrix
    } = tileHeader.content;
    const {positions, normals, colors} = attributes;

    if (!positions) {
      return null;
    }

    const {getColor, pointSize} = this.props;
    const SubLayerClass = this.getSubLayerClass('pointcloud', PointCloudLayer);

    return new SubLayerClass(
      {
        pointSize
      },
      this.getSubLayerProps({
        id: 'pointcloud'
      }),
      {
        id: `${this.id}-pointcloud-${tileHeader.fullUri}`,
        data: {
          header: {
            vertexCount: pointCount
          },
          attributes: {
            POSITION: positions,
            NORMAL: normals,
            COLOR_0: colors
          }
        },
        coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
        coordinateOrigin: cartographicOrigin,
        modelMatrix,

        getColor: constantRGBA || getColor
      }
    );
  }

  renderLayers() {
    return this.state.layers;
  }
}

Tile3DLayer.layerName = 'Tile3DLayer';
Tile3DLayer.defaultProps = defaultProps;
