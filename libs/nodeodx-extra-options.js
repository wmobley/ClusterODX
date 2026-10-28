'use strict';

// Options in the NodeODX 1.0.18 public schema not present in ClusterODM's fallback.
module.exports = [
    {
        name: "end-with",
        type: "enum",
        value: "odm_postprocess",
        domain: ["dataset", "split", "merge", "opensfm", "openmvs", "odm_filterpoints", "odm_meshing", "mvs_texturing", "odm_georeferencing", "odm_dem", "odm_orthophoto", "odm_report", "odm_postprocess"],
        help: "End processing at this stage. Can be one of: %(choices)s. Default: %(default)s"
    },
    {
        name: "rerun-from",
        type: "enum",
        value: "",
        domain: ["", "dataset", "split", "merge", "opensfm", "openmvs", "odm_filterpoints", "odm_meshing", "mvs_texturing", "odm_georeferencing", "odm_dem", "odm_orthophoto", "odm_report", "odm_postprocess"],
        help: "Rerun processing from this stage. Can be one of: %(choices)s. Default: %(default)s"
    },
    {
        name: "matcher-neighbors",
        type: "int",
        value: "0",
        domain: "positive integer",
        help: "Perform image matching with the nearest images based on GPS exif data. Set to 0 to match by triangulation. Default: %(default)s"
    },
    {
        name: "use-fixed-camera-params",
        type: "bool",
        value: "false",
        domain: "",
        help: "Turn off camera parameter optimization during bundle adjustment. This can be sometimes useful for improving results that exhibit doming/bowling or when images are taken with a rolling shutter camera. Default: %(default)s"
    },
    {
        name: "cameras",
        type: "string",
        value: "",
        domain: "json",
        help: "Use the camera parameters computed from another dataset instead of calculating them. Can be specified either as path to a cameras.json file or as a JSON string representing the contents of a cameras.json file. Default: %(default)s"
    },
    {
        name: "use-hybrid-bundle-adjustment",
        type: "bool",
        value: "false",
        domain: "",
        help: "Run local bundle adjustment for every image added to the reconstruction and a global adjustment every 100 images. Speeds up reconstruction for very large datasets. Default: %(default)s"
    },
    {
        name: "sfm-algorithm",
        type: "enum",
        value: "incremental",
        domain: ["incremental", "triangulation", "planar"],
        help: "Choose the structure from motion algorithm. For aerial datasets, if camera GPS positions and angles are available, triangulation can generate better results. For planar scenes captured at fixed altitude with nadir-only images, planar can be much faster. Can be one of: %(choices)s. Default: %(default)s"
    },
    {
        name: "sky-removal",
        type: "bool",
        value: "false",
        domain: "",
        help: "Automatically compute image masks using AI to remove the sky. Experimental. Default: %(default)s"
    },
    {
        name: "bg-removal",
        type: "bool",
        value: "false",
        domain: "",
        help: "Automatically compute image masks using AI to remove the background. Experimental. Default: %(default)s"
    },
    {
        name: "skip-report",
        type: "bool",
        value: "false",
        domain: "",
        help: "Skip generation of PDF report. This can save time if you don't need a report. Default: %(default)s"
    },
    {
        name: "skip-orthophoto",
        type: "bool",
        value: "false",
        domain: "",
        help: "Skip generation of the orthophoto. This can save time if you only need 3D results or DEMs. Default: %(default)s"
    },
    {
        name: "no-gpu",
        type: "bool",
        value: "false",
        domain: "",
        help: "Do not use GPU acceleration, even if it's available. Default: %(default)s"
    },
    {
        name: "mesh-size",
        type: "int",
        value: "200000",
        domain: "positive integer",
        help: "The maximum vertex count of the output mesh. Default: %(default)s"
    },
    {
        name: "mesh-octree-depth",
        type: "int",
        value: "11",
        domain: "integer: 1 <= x <= 14",
        help: "Octree depth used in the mesh reconstruction, increase to get more vertices, recommended values are 8-12. Default: %(default)s"
    },
    {
        name: "fast-orthophoto",
        type: "bool",
        value: "false",
        domain: "",
        help: "Skips dense reconstruction and 3D model generation. It generates an orthophoto directly from the sparse reconstruction. If you just need an orthophoto and do not need a full 3D model, turn on this option. Default: %(default)s"
    },
    {
        name: "auto-boundary-distance",
        type: "float",
        value: "0",
        domain: "positive float",
        help: "Specify the distance between camera shot locations and the outer edge of the boundary when computing the boundary with --auto-boundary. Set to 0 to automatically choose a value. Default: %(default)s"
    },
    {
        name: "pc-csv",
        type: "bool",
        value: "false",
        domain: "",
        help: "Export the georeferenced point cloud in CSV format. Default: %(default)s"
    },
    {
        name: "pc-las",
        type: "bool",
        value: "false",
        domain: "",
        help: "Export the georeferenced point cloud in LAS format. Default: %(default)s"
    },
    {
        name: "pc-ept",
        type: "bool",
        value: "false",
        domain: "",
        help: "Export the georeferenced point cloud in Entwine Point Tile (EPT) format. Default: %(default)s"
    },
    {
        name: "pc-copc",
        type: "bool",
        value: "false",
        domain: "",
        help: "Save the georeferenced point cloud in Cloud Optimized Point Cloud (COPC) format. Default: %(default)s"
    },
    {
        name: "pc-sample",
        type: "float",
        value: "0",
        domain: "positive float",
        help: "Filters the point cloud by keeping only a single point around a radius N (in meters). This can be useful to limit the output resolution of the point cloud and remove duplicate points. Set to 0 to disable sampling. Default: %(default)s"
    },
    {
        name: "pc-skip-geometric",
        type: "bool",
        value: "false",
        domain: "",
        help: "Geometric estimates improve the accuracy of the point cloud by computing geometrically consistent depthmaps but may not be usable in larger datasets. This flag disables geometric estimates. Default: %(default)s"
    },
    {
        name: "pc-tile",
        type: "bool",
        value: "false",
        domain: "",
        help: "Reduce the memory usage needed for depthmap fusion by splitting large scenes into tiles. Turn this on if your machine doesn't have much RAM and/or you've set --pc-quality to high or ultra. Experimental. Default: %(default)s"
    },
    {
        name: "smrf-scalar",
        type: "float",
        value: "1.25",
        domain: "positive float",
        help: "Simple Morphological Filter elevation scalar parameter. Default: %(default)s"
    },
    {
        name: "smrf-slope",
        type: "float",
        value: "0.15",
        domain: "positive float",
        help: "Simple Morphological Filter slope parameter (rise over run). Default: %(default)s"
    },
    {
        name: "smrf-threshold",
        type: "float",
        value: "0.5",
        domain: "positive float",
        help: "Simple Morphological Filter elevation threshold parameter (meters). Default: %(default)s"
    },
    {
        name: "smrf-window",
        type: "float",
        value: "18.0",
        domain: "positive float",
        help: "Simple Morphological Filter window radius parameter (meters). Default: %(default)s"
    },
    {
        name: "texturing-skip-global-seam-leveling",
        type: "bool",
        value: "false",
        domain: "",
        help: "Skip normalization of colors across all images. Useful when processing radiometric data. Default: %(default)s"
    },
    {
        name: "texturing-skip-local-seam-leveling",
        type: "bool",
        value: "false",
        domain: "",
        help: "Skip the blending of colors near seams. Default: %(default)s"
    },
    {
        name: "texturing-keep-unseen-faces",
        type: "bool",
        value: "false",
        domain: "",
        help: "Keep faces in the mesh that are not seen in any camera. Default:  %(default)s"
    },
    {
        name: "texturing-single-material",
        type: "bool",
        value: "false",
        domain: "",
        help: "Generate OBJs that have a single material and a single texture file instead of multiple ones. Default:  %(default)s"
    },
    {
        name: "gltf",
        type: "bool",
        value: "false",
        domain: "",
        help: "Generate single file Binary glTF (GLB) textured models. Default: %(default)s"
    },
    {
        name: "use-exif",
        type: "bool",
        value: "false",
        domain: "",
        help: "Use this tag if you have a GCP File but want to use the EXIF information for georeferencing instead. Default: %(default)s"
    },
    {
        name: "dem-gapfill-steps",
        type: "int",
        value: "3",
        domain: "positive integer",
        help: "Number of steps used to fill areas with gaps. Set to 0 to disable gap filling. Starting with a radius equal to the output resolution, N different DEMs are generated with progressively bigger radius using the inverse distance weighted (IDW) algorithm and merged together. Remaining gaps are then merged using nearest neighbor interpolation. Default: %(default)s"
    },
    {
        name: "dem-decimation",
        type: "int",
        value: "1",
        domain: "positive integer",
        help: "Decimate the points before generating the DEM. 1 is no decimation (full quality). 100 decimates ~99%% of the points. Useful for speeding up generation of DEM results in very large datasets. Default: %(default)s"
    },
    {
        name: "dem-euclidean-map",
        type: "bool",
        value: "false",
        domain: "",
        help: "Computes an euclidean raster map for each DEM. The map reports the distance from each cell to the nearest NODATA value (before any hole filling takes place). This can be useful to isolate the areas that have been filled. Default: %(default)s"
    },
    {
        name: "orthophoto-no-tiled",
        type: "bool",
        value: "false",
        domain: "",
        help: "Set this parameter if you want a striped GeoTIFF. Default: %(default)s"
    },
    {
        name: "orthophoto-png",
        type: "bool",
        value: "false",
        domain: "",
        help: "Set this parameter if you want to generate a PNG rendering of the orthophoto. Default: %(default)s"
    },
    {
        name: "orthophoto-kmz",
        type: "bool",
        value: "false",
        domain: "",
        help: "Set this parameter if you want to generate a Google Earth (KMZ) rendering of the orthophoto. Default: %(default)s"
    },
    {
        name: "orthophoto-cutline",
        type: "bool",
        value: "false",
        domain: "",
        help: "Generates a polygon around the cropping area that cuts the orthophoto around the edges of features. This polygon can be useful for stitching seamless mosaics with multiple overlapping orthophotos. Default: %(default)s"
    },
    {
        name: "tiles",
        type: "bool",
        value: "false",
        domain: "",
        help: "Generate static tiles for orthophotos and DEMs that are suitable for viewers like Leaflet or OpenLayers. Default: %(default)s"
    },
    {
        name: "3d-tiles",
        type: "bool",
        value: "false",
        domain: "",
        help: "Generate OGC 3D Tiles outputs. Default: %(default)s"
    },
    {
        name: "rolling-shutter",
        type: "bool",
        value: "false",
        domain: "",
        help: "Turn on rolling shutter correction. If the camera has a rolling shutter and the images were taken in motion, you can turn on this option to improve the accuracy of the results. See also --rolling-shutter-readout. Default: %(default)s"
    },
    {
        name: "rolling-shutter-readout",
        type: "float",
        value: "0",
        domain: "positive integer",
        help: "Override the rolling shutter readout time for your camera sensor (in milliseconds), instead of using the rolling shutter readout database. Note that not all cameras are present in the database. Set to 0 to use the database value. Default: %(default)s"
    },
    {
        name: "build-overviews",
        type: "bool",
        value: "false",
        domain: "",
        help: "Build orthophoto overviews for faster display in programs such as QGIS. Default: %(default)s"
    },
    {
        name: "cog",
        type: "bool",
        value: "false",
        domain: "",
        help: "Create Cloud-Optimized GeoTIFFs instead of normal GeoTIFFs. Default: %(default)s"
    },
    {
        name: "video-limit",
        type: "int",
        value: "500",
        domain: "positive integer",
        help: "Maximum number of frames to extract from video files for processing. Set to 0 for no limit. Default: %(default)s"
    },
    {
        name: "video-resolution",
        type: "int",
        value: "4000",
        domain: "positive integer",
        help: "The maximum output resolution of extracted video frames in pixels. Default: %(default)s"
    },
    {
        name: "sm-no-align",
        type: "bool",
        value: "false",
        domain: "",
        help: "Skip alignment of submodels in split-merge. Useful if GPS is good enough on very large datasets. Default: %(default)s"
    },
    {
        name: "merge",
        type: "enum",
        value: "all",
        domain: ["all", "pointcloud", "orthophoto", "dem"],
        help: "Choose what to merge in the merge step in a split dataset. By default all available outputs are merged. Options: %(choices)s. Default: %(default)s"
    },
    {
        name: "skip-band-alignment",
        type: "bool",
        value: "false",
        domain: "",
        help: "When processing multispectral datasets, ODM will automatically align the images for each band. If they have been postprocessed and are already aligned, use this option. Default: %(default)s"
    }
];
