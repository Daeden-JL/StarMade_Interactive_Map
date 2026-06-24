package com.starmade.map;

import org.junit.jupiter.api.Test;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.List;
import org.schema.game.common.controller.database.DatabaseEntry;
import org.schema.game.common.controller.database.tables.Table;

import java.io.File;
import org.schema.game.common.controller.SegmentController;
import static org.junit.jupiter.api.Assertions.*;

public class DatabaseTest {

    @Test
    public void testMapAllEntities() throws Exception {
        Class.forName("org.hsqldb.jdbc.JDBCDriver");
        System.out.println("HSQLDB JAR Location: " + 
            Class.forName("org.hsqldb.jdbc.JDBCDriver").getProtectionDomain().getCodeSource().getLocation());

        String url = "jdbc:hsqldb:file:server-database/world0/index/;readonly=true;shutdown=true;hsqldb.nio_data_file=false";
        try (Connection conn = DriverManager.getConnection(url, "SA", "")) {
            assertNotNull(conn, "Should connect to HSQLDB database");

            System.out.println("=== SYSTEMS SCHEMA ===");
            try (java.sql.ResultSet cols = conn.getMetaData().getColumns(null, null, "SYSTEMS", null)) {
                while (cols.next()) {
                    System.out.println("Col: " + cols.getString("COLUMN_NAME") + " (" + cols.getString("TYPE_NAME") + ")");
                }
            }

            System.out.println("=== ENTITIES SCHEMA ===");
            try (java.sql.ResultSet cols = conn.getMetaData().getColumns(null, null, "ENTITIES", null)) {
                while (cols.next()) {
                    System.out.println("Col: " + cols.getString("COLUMN_NAME") + " (" + cols.getString("TYPE_NAME") + ")");
                }
            }

            System.out.println("=== ENTITY COUNTS BY TYPE AND FACTION ===");
            try (Statement stmt2 = conn.createStatement();
                 java.sql.ResultSet rs = stmt2.executeQuery(
                     "SELECT TYPE, " +
                     "       COUNT(*) as TOTAL, " +
                     "       SUM(CASE WHEN FACTION <> 0 THEN 1 ELSE 0 END) as HAS_FACTION " +
                     "FROM ENTITIES GROUP BY TYPE")) {
                while (rs.next()) {
                    System.out.println("Type: " + rs.getInt("TYPE") + 
                                       ", Total: " + rs.getInt("TOTAL") + 
                                       ", FactionOwned: " + rs.getInt("HAS_FACTION"));
                }
            } catch (java.sql.SQLException e) {
                System.out.println("SQL ERROR: " + e.getMessage());
                throw e;
            }

            System.out.println("=== SAMPLE ENTITIES ===");
            try (Statement stmt3 = conn.createStatement();
                 java.sql.ResultSet rs = stmt3.executeQuery("SELECT * FROM ENTITIES")) {
                List<org.schema.game.common.controller.database.DatabaseEntry> dbEntries = 
                    org.schema.game.common.controller.database.tables.Table.resultToList(rs);
                int count = 0;
                for (org.schema.game.common.controller.database.DatabaseEntry entry : dbEntries) {
                    if (count++ >= 20) break;
                    System.out.println("UID: " + entry.uid + 
                                       ", Name: " + entry.realName + 
                                       ", Type: " + entry.type + 
                                       ", MinPos: " + entry.minPos + 
                                       ", MaxPos: " + entry.maxPos);
                }
            }
        }
    }
}
