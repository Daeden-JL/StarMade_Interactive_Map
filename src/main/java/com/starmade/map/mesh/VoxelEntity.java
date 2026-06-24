package com.starmade.map.mesh;

import org.schema.game.common.controller.SegmentBufferInterface;
import org.schema.game.common.controller.Vector3iSegment;

public interface VoxelEntity {
    int getId();
    Vector3iSegment getMinPos();
    Vector3iSegment getMaxPos();
    SegmentBufferInterface getSegmentBuffer();
}
