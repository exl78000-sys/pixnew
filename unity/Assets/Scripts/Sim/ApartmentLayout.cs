using System.Collections.Generic;
using Newtonsoft.Json;

namespace Pixnew.Sim
{
    /// <summary>
    /// 公寓佈局資料,對應 StreamingAssets/content/apartment-layout.json。
    /// 座標系:格為單位,x 向右、y 向下(第 0 列在最上面);
    /// 轉成 Unity Tilemap 座標時由使用端翻轉 y。
    /// </summary>
    public class ApartmentLayout
    {
        [JsonProperty("grid")] public GridSpec Grid;
        [JsonProperty("sheets")] public Dictionary<string, string> Sheets = new();
        [JsonProperty("floorTiles")] public Dictionary<string, FloorTileSpec> FloorTiles = new();
        [JsonProperty("wallTiles")] public Dictionary<string, int[]> WallTiles = new();
        [JsonProperty("rooms")] public List<RoomSpec> Rooms = new();
        [JsonProperty("extraFloor")] public List<ExtraFloorSpec> ExtraFloor = new();
        [JsonProperty("walls")] public List<WallRunSpec> Walls = new();
        [JsonProperty("objects")] public List<ObjectSpec> Objects = new();
        [JsonProperty("doors")] public List<DoorSpec> Doors = new();
    }

    /// <summary>邏輯網格尺寸(格)</summary>
    public class GridSpec
    {
        [JsonProperty("width")] public int Width;
        [JsonProperty("height")] public int Height;
    }

    /// <summary>地板磚:圖集、基準格、無縫重複區塊大小</summary>
    public class FloorTileSpec
    {
        [JsonProperty("sheet")] public string Sheet;
        [JsonProperty("cell")] public int[] Cell;    // [col, row](圖集格,row 由上往下)
        [JsonProperty("block")] public int[] Block;  // [w, h] 取樣週期
    }

    /// <summary>房間:id、矩形範圍(x, y, w, h)、地板樣式</summary>
    public class RoomSpec
    {
        [JsonProperty("id")] public string Id;
        [JsonProperty("rect")] public int[] Rect;
        [JsonProperty("floor")] public string Floor;
    }

    /// <summary>房間以外的補地板區(如門洞)</summary>
    public class ExtraFloorSpec
    {
        [JsonProperty("rect")] public int[] Rect;
        [JsonProperty("floor")] public string Floor;
    }

    /// <summary>一段牆:dir = "h"(水平,佔 y 與 y+1 兩列)或 "v"(垂直,寬 1 格);gaps = 門洞(相對整條牆的絕對 x 或 y 與長度)</summary>
    public class WallRunSpec
    {
        [JsonProperty("dir")] public string Dir;
        [JsonProperty("x")] public int X;
        [JsonProperty("y")] public int Y;
        [JsonProperty("len")] public int Len;
        [JsonProperty("gaps")] public List<int[]> Gaps = new();
    }

    /// <summary>具名物件:圖集矩形(格)、擺放位置(左上格)、互動點(相鄰可走格)、是否可踩(如地毯)</summary>
    public class ObjectSpec
    {
        [JsonProperty("id")] public string Id;
        [JsonProperty("sheet")] public string Sheet;
        [JsonProperty("atlas")] public int[] Atlas;  // [col, row, w, h]
        [JsonProperty("pos")] public int[] Pos;      // [x, y] 左上格
        [JsonProperty("use")] public int[] Use;      // [x, y] 互動點
        [JsonProperty("walkable")] public bool Walkable;
    }

    /// <summary>門(牆上的洞)的具名點位</summary>
    public class DoorSpec
    {
        [JsonProperty("id")] public string Id;
        [JsonProperty("pos")] public int[] Pos;
    }
}
